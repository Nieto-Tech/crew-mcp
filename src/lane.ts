import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userConfigPath, type WorkerConfig } from "./config.js";
import { log } from "./log.js";
import { fmtDuration, readUsage, usageLogPath } from "./usage.js";

/* ---------- one request at a time per local worker, across every crew process ---------- */

// A local GPU can't usefully run two agent loops at once: they fight over the same model,
// and each one's clock would be burning while it waits. Every Claude Code session starts its
// own crew server, so an in-memory queue alone only orders one session's calls. Two layers:
//   1. In-process: this process's waiting calls, best first (see "Priority" below).
//   2. Cross-process: while any of them wait, the process holds one ticket file in the lane's
//      directory, standing for its best waiting call. The best live ticket holds the worker, and
//      that process runs its best call. Its next call takes a fresh ticket, so it goes behind other
//      sessions already waiting: sessions take turns, and a burst can't hog the GPU.
// A ticket is kept fresh by a heartbeat. One whose process is gone, or whose heartbeat stopped,
// is removed by whoever sees it, so a crashed session can't wedge the lane.
//
// Priority: a recon is exploration and can usually wait; a diff review is what stands between
// Claude and "done". So every other call goes ahead of a waiting recon, until that recon has
// waited `reconYieldMs` (default 3 min); after that it is passed by no one. Nothing is ever
// interrupted: a call that has started always finishes.

const POLL_MS = 250;
const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
/** How often a queued call reports where it stands. */
const NOTE_MS = 20_000;
/** A call starts only after its ticket has been first in line, with nothing running, for this long: long enough for a
 *  ticket named a moment before ours, but published a moment after, to show up. */
const SETTLE_MS = 15;
/** Used for the wait estimate when the usage log has no history for a tool yet. */
const DEFAULT_CALL_MS = 90_000;

/** 1 = yields to other calls for a while (recon); 0 = everything else. */
type Prio = 0 | 1;
export const priorityOf = (tool: string): Prio => (tool === "crew_recon" ? 1 : 0);

/** Workers sharing a server share a lane (two entries pointing at one Ollama are one GPU). */
export const laneKey = (w: WorkerConfig) =>
  `${w.provider}:${(w.baseUrl || (w.provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com/v1")).replace(/\/$/, "")}`;

export const lanesDir = () => path.join(path.dirname(usageLogPath()), "lanes");
const laneDir = (w: WorkerConfig) => path.join(lanesDir(), laneKey(w).replace(/[^A-Za-z0-9.-]+/g, "_"));

/* ---------- ticket files ---------- */

interface TicketData {
  pid: number;
  host: string;
  /** Repo directory name only, as in the usage log. */
  workspace: string;
  tool: string;
  prio: Prio;
  /** Place in line: when this session got in line for this turn, or when the call it stands for arrived, if later;
   *  for a recon that has stopped yielding, no later than when it stopped, so nothing that arrives after passes it. */
  key: number;
  /** When a prio-1 ticket stops yielding (absolute, so every reader agrees). */
  yieldsUntil?: number;
  startedAt?: number;
}
interface Ticket extends Partial<TicketData> {
  file: string;
  pid: number;
  /** From the file name: when the ticket was taken. */
  takenAt: number;
  mtimeMs: number;
}

const TICKET = /^(\d+)-(\d+)-(\d+)\.json$/;
let seq = 0;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // exists, but belongs to someone else
  }
}

const tmpOf = (file: string) => path.join(path.dirname(file), `.${path.basename(file)}.tmp`);

/** Write via a temp file and rename, so a reader never sees half a ticket. */
function writeTicket(file: string, data: TicketData) {
  fs.writeFileSync(tmpOf(file), JSON.stringify(data));
  fs.renameSync(tmpOf(file), file);
}

function removeTicket(file: string) {
  fs.rmSync(file, { force: true });
  fs.rmSync(tmpOf(file), { force: true });
}

// A stopped heartbeat only means a dead holder if *we* have been awake to see it stop. After a laptop sleeps, every
// ticket's heartbeat looks 30s+ old, holder included, so no process judges heartbeats until STALE_MS after it woke.
let awakeSince = 0;
let lastTick = 0;
let ticker: NodeJS.Timeout | undefined;
function checkClock() {
  const now = Date.now();
  if (lastTick && now - lastTick > 5_000) awakeSince = now;
  lastTick = now;
}
function watchClock() {
  if (ticker) return;
  lastTick = Date.now();
  ticker = setInterval(checkClock, 1_000);
  ticker.unref();
}

/** Live tickets. Stale ones are removed on the way. Throws if the directory can't be read. */
function liveTickets(dir: string): Ticket[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => TICKET.test(n));
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  if (ticker) checkClock();
  const out: Ticket[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (e: any) {
      if (e?.code === "ENOENT") continue; // released while we looked
      mtimeMs = Date.now(); // can't tell: count it as live rather than run over it
    }
    let data: Partial<TicketData> = {};
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* the name still says whose it is */
    }
    const [, taken, pidStr] = TICKET.exec(name)!;
    const pid = Number(pidStr);
    const gone = pid !== process.pid && (!data.host || data.host === os.hostname()) && !alive(pid);
    const silent = Date.now() - mtimeMs > STALE_MS && Date.now() - awakeSince > STALE_MS;
    if (gone || silent) {
      try {
        fs.unlinkSync(file);
        log(`lane: removed stale ticket ${name} (${gone ? "process gone" : "no heartbeat"})`);
      } catch {
        /* someone else removed it */
      }
      continue;
    }
    out.push({ ...data, file, pid, takenAt: Number(taken), mtimeMs });
  }
  return out;
}

const effPrio = (prio: Prio | undefined, yieldsUntil: number | undefined, now = Date.now()): Prio =>
  prio === 1 && (yieldsUntil === undefined || now < yieldsUntil) ? 1 : 0;

/** Started tickets, and the waiting ones best first. An unreadable ticket counts as prio 0, in line from when it was taken. */
function order(tickets: Ticket[]) {
  const now = Date.now();
  const started = tickets.filter((t) => t.startedAt);
  const waiting = tickets
    .filter((t) => !t.startedAt)
    .map((t) => ({ t, p: effPrio(t.prio, t.yieldsUntil, now), k: t.key ?? t.takenAt }))
    .sort((a, b) => a.p - b.p || a.k - b.k || (a.t.file < b.t.file ? -1 : 1))
    .map((x) => x.t);
  return { started, waiting };
}

/* ---------- this process's side of a lane ---------- */

interface Waiter {
  tool: string;
  workspace: string;
  prio: Prio;
  arrivedAt: number;
  yieldsUntil?: number;
  n: number;
  grant: (release: () => void) => void;
}

interface Lane {
  w: WorkerConfig;
  dir: string;
  waiters: Waiter[];
  running?: { tool: string; workspace: string; startedAt: number };
  ticket?: { file: string; takenAt: number; data: TicketData };
  beat?: NodeJS.Timeout;
  driving: boolean;
}
const lanes = new Map<string, Lane>();
const laneFor = (w: WorkerConfig) => {
  const key = laneKey(w);
  let lane = lanes.get(key);
  if (!lane) lanes.set(key, (lane = { w, dir: laneDir(w), waiters: [], driving: false }));
  return lane;
};

let waiterSeq = 0;
const byBest = (now: number) => (a: Waiter, b: Waiter) =>
  effPrio(a.prio, a.yieldsUntil, now) - effPrio(b.prio, b.yieldsUntil, now) || a.arrivedAt - b.arrivedAt || a.n - b.n;
const bestWaiter = (lane: Lane) => [...lane.waiters].sort(byBest(Date.now()))[0];

/** Never throws: a ticket left behind goes stale and is removed by the next process that looks. */
function dropTicket(lane: Lane) {
  clearInterval(lane.beat);
  lane.beat = undefined;
  try {
    if (lane.ticket) removeTicket(lane.ticket.file);
  } catch (e: any) {
    log(`lane: ticket not removed (${e?.message || e}); it goes stale in ${STALE_MS / 1000}s`);
  }
  lane.ticket = undefined;
}

function keyFor(takenAt: number, rep: Waiter, now = Date.now()) {
  const key = Math.max(takenAt, rep.arrivedAt);
  return rep.yieldsUntil !== undefined && now >= rep.yieldsUntil ? Math.min(key, rep.yieldsUntil) : key;
}

/** Make the ticket stand for `rep`: take one if there is none, rewrite it if what it says has changed. */
function syncTicket(lane: Lane, rep: Waiter, startedAt?: number) {
  if (!lane.ticket) {
    fs.mkdirSync(lane.dir, { recursive: true });
    const takenAt = Date.now();
    lane.ticket = { file: path.join(lane.dir, `${String(takenAt).padStart(15, "0")}-${process.pid}-${seq++}.json`), takenAt, data: undefined as any };
    if (!lane.beat) {
      lane.beat = setInterval(() => {
        try {
          if (lane.ticket) fs.utimesSync(lane.ticket.file, new Date(), new Date());
        } catch {
          /* gone: the driver notices and takes a new one */
        }
      }, HEARTBEAT_MS);
      lane.beat.unref();
    }
  }
  const data: TicketData = {
    pid: process.pid,
    host: os.hostname(),
    workspace: rep.workspace,
    tool: rep.tool,
    prio: rep.prio,
    key: keyFor(lane.ticket.takenAt, rep),
    ...(rep.yieldsUntil !== undefined ? { yieldsUntil: rep.yieldsUntil } : {}),
    ...(startedAt ? { startedAt } : {}),
  };
  const old = lane.ticket.data;
  if (!old || JSON.stringify(old) !== JSON.stringify(data)) {
    writeTicket(lane.ticket.file, data);
    lane.ticket.data = data;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function start(lane: Lane, waiter: Waiter, startedAt = Date.now()) {
  lane.waiters = lane.waiters.filter((x) => x !== waiter);
  lane.running = { tool: waiter.tool, workspace: waiter.workspace, startedAt };
  let released = false;
  waiter.grant(() => {
    if (released) return;
    released = true;
    lane.running = undefined;
    dropTicket(lane);
    if (lane.waiters.length) void drive(lane); // our next call goes to the back of the line
  });
}

/** Get this process's best waiting call onto the worker, when its turn comes. One driver per lane at a time. */
async function drive(lane: Lane) {
  if (lane.driving) return;
  lane.driving = true;
  try {
    let firstSince = 0; // when our ticket was first seen at the head of the line with nothing running
    while (lane.waiters.length && !lane.running) {
      let rep = bestWaiter(lane);
      try {
        syncTicket(lane, rep);
        const { started, waiting } = order(liveTickets(lane.dir));
        const mine = lane.ticket!.file;
        if (![...started, ...waiting].some((t) => t.file === mine)) {
          // Our ticket was removed as stale (this process was suspended past STALE_MS): take a new one, at the back.
          lane.ticket = undefined;
          firstSince = 0;
        } else if (!started.length && waiting[0]?.file === mine) {
          if (!firstSince) firstSince = Date.now();
          else if (Date.now() - firstSince >= SETTLE_MS) {
            rep = bestWaiter(lane); // may have changed while we settled
            const at = Date.now();
            syncTicket(lane, rep, at);
            // Claim, then check: if another process started meanwhile (its view of the line differed, e.g. a recon
            // stopped yielding between our scans), back off. Whoever checks after both claims are visible sees the
            // other and backs off, so at most one goes ahead; if both back off, the next round settles it.
            if (liveTickets(lane.dir).some((t) => t.startedAt && t.file !== lane.ticket!.file)) {
              syncTicket(lane, rep);
              firstSince = 0;
            } else {
              start(lane, rep, at);
              break;
            }
          }
        } else firstSince = 0;
      } catch (e: any) {
        // The state dir is unusable: run with this process's queue only, rather than fail the call.
        log(`lane: cross-session queue unavailable (${e?.message || e}); queueing within this session only for this call`);
        dropTicket(lane);
        start(lane, bestWaiter(lane));
        break;
      }
      await sleep(firstSince ? SETTLE_MS : POLL_MS);
    }
    if (!lane.waiters.length && !lane.running) dropTicket(lane); // the last waiter gave up
  } finally {
    lane.driving = false;
  }
}

/* ---------- what the queue looks like, and how long it will take ---------- */

interface Entry {
  tool?: string;
  workspace?: string;
  prio: Prio;
  /** Place in line, as in `order`. */
  key: number;
  thisSession: boolean;
  /** This session's own waiting calls: which one. */
  n?: number;
}

export interface LaneView {
  running: number;
  waiting: number;
  holder?: { tool?: string; workspace?: string; heldMs: number; thisSession: boolean };
  /** The waiting calls, best first (this session's own calls in its ticket's place). */
  queued: Entry[];
}

export function laneView(w: WorkerConfig): LaneView {
  const lane = laneFor(w);
  const now = Date.now();
  let tickets: Ticket[] = [];
  try {
    tickets = liveTickets(lane.dir);
  } catch {
    /* unreadable: fall back to this process's own state */
  }
  const { started, waiting } = order(tickets);
  const mine = [...lane.waiters].sort(byBest(now)).map((x): Entry => ({ tool: x.tool, workspace: x.workspace, prio: effPrio(x.prio, x.yieldsUntil, now), key: x.arrivedAt, thisSession: true, n: x.n }));
  const queued: Entry[] = [];
  let placed = false;
  for (const t of waiting) {
    if (t.pid === process.pid) {
      queued.push(...mine);
      placed = true;
    } else queued.push({ tool: t.tool, workspace: t.workspace, prio: effPrio(t.prio, t.yieldsUntil, now), key: t.key ?? t.takenAt, thisSession: false });
  }
  if (!placed) queued.push(...mine);
  const h = started[0];
  const holder = h
    ? { tool: h.tool, workspace: h.workspace, heldMs: Math.max(0, now - (h.startedAt ?? h.mtimeMs)), thisSession: h.pid === process.pid }
    : lane.running
      ? { tool: lane.running.tool, workspace: lane.running.workspace, heldMs: now - lane.running.startedAt, thisSession: true }
      : undefined;
  return { running: holder ? 1 : 0, waiting: queued.length, holder, queued };
}

let medians: { at: number; worker: string; byTool: Map<string, number>; all: number } | undefined;

/** Median wall time per tool for this worker, from the usage log (cached for a minute). */
function typicalMs(worker: string) {
  if (medians && medians.worker === worker && Date.now() - medians.at < 60_000) return medians;
  const rows = readUsage().filter((e) => e.worker === worker && e.outcome !== "error").slice(-200);
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] * 1000 : DEFAULT_CALL_MS;
  };
  const byTool = new Map<string, number>();
  for (const tool of new Set(rows.map((e) => e.tool))) byTool.set(tool, med(rows.filter((e) => e.tool === tool).map((e) => e.wallSeconds)));
  medians = { at: Date.now(), worker, byTool, all: med(rows.map((e) => e.wallSeconds)) };
  return medians;
}

/** Rough time until the holder and `ahead` queued calls are done. From past calls; an estimate, not a promise. */
export function estimateWaitMs(v: LaneView, worker: string, ahead = v.queued.length): number {
  const t = typicalMs(worker);
  const of = (tool?: string) => (tool && t.byTool.get(tool)) || t.all;
  const holderLeft = v.holder ? Math.max(15_000, of(v.holder.tool) - v.holder.heldMs) : 0;
  return holderLeft + v.queued.slice(0, ahead).reduce((s, e) => s + of(e.tool), 0);
}

const roughly = (ms: number) => (ms < 60_000 ? "under a minute" : `~${Math.round(ms / 60_000)} min`);

/** "crew_recon for oyedev-hub, 1m05s so far" */
export function describeHolder(v: LaneView): string {
  const h = v.holder;
  if (!h) return "nothing";
  const who = h.thisSession ? "this session" : h.workspace || "another session";
  return `${h.tool || "a call"} for ${who}, ${fmtDuration(h.heldMs / 1000)} so far`;
}

/** The queue part of a crew_status worker line, or "" when the lane is idle. */
export function queueLine(w: WorkerConfig, worker: string): string {
  const v = laneView(w);
  if (!v.running && !v.waiting) return "";
  return ` · queue: ${v.running} running, ${v.waiting} queued (now: ${describeHolder(v)}; clear in ${roughly(estimateWaitMs(v, worker))}, est.)`;
}

/* ---------- taking and giving back the worker ---------- */

function busyError(name: string, w: WorkerConfig, waitMs: number): Error {
  const v = laneView(w);
  return new Error(
    `Worker "${name}" is busy: gave up after waiting ${fmtDuration(waitMs / 1000)} in the queue ` +
      `(holding it: ${describeHolder(v)}; ${v.waiting} other call(s) waiting). ` +
      `The local GPU runs one crew call at a time for every session on this machine, so resending this call now, ` +
      `or alongside other crew calls, only queues it again. ` +
      `Fix: try again once the queue clears (crew_status shows it), or raise queueWaitMs for "${name}" in ${userConfigPath()}.`
  );
}

/** One line about where a waiting call stands. */
function waitNote(label: string, name: string, v: LaneView, me: Waiter): string | undefined {
  if (!v.running && !v.queued.some((e) => !e.thisSession)) return undefined;
  const i = v.queued.findIndex((e) => e.n === me.n);
  const ahead = i < 0 ? v.queued.length : i;
  const passed = v.queued.slice(0, ahead).filter((e) => e.prio === 0 && e.key > me.arrivedAt).length;
  const yielding = me.prio === 1 && me.yieldsUntil !== undefined && Date.now() < me.yieldsUntil;
  return (
    `${label} is busy (${describeHolder(v)}; ${ahead} ahead of this call). Queued, est. wait ${roughly(estimateWaitMs(v, name, ahead))}` +
    (passed ? `; ${passed} later call(s) went ahead of this recon` : "") +
    (yielding ? `; reviews go first until it has waited ${fmtDuration((me.yieldsUntil! - me.arrivedAt) / 1000)}` : "") +
    "…"
  );
}

/**
 * Wait for the worker, then hold it until the returned release is called. Waits at most `waitMs`,
 * then throws. `onWait` gets a line about the queue now and then while waiting.
 */
export async function acquire(
  w: WorkerConfig,
  name: string,
  o: { waitMs: number; workspace: string; tool: string; yieldMs: number; onWait?: (msg: string) => void }
): Promise<() => void> {
  watchClock();
  const lane = laneFor(w);
  const arrivedAt = Date.now();
  const prio = priorityOf(o.tool);
  let release: (() => void) | undefined;
  let resolveGrant!: (r: () => void) => void;
  const granted = new Promise<() => void>((r) => (resolveGrant = r));
  const me: Waiter = {
    tool: o.tool,
    workspace: o.workspace,
    prio,
    arrivedAt,
    ...(prio === 1 ? { yieldsUntil: arrivedAt + o.yieldMs } : {}),
    n: waiterSeq++,
    grant: (r) => resolveGrant((release = r)),
  };
  lane.waiters.push(me);
  void drive(lane);

  const note = () => {
    if (release) return;
    try {
      const msg = waitNote(w.label || name, name, laneView(w), me);
      if (msg) o.onWait?.(msg);
    } catch (e: any) {
      log(`lane: queue note failed (${e?.message || e})`); // a progress note must never break the wait
    }
  };
  // Give the driver one look first, so a call on an idle lane starts without a "busy" note.
  const first = setTimeout(note, SETTLE_MS * 4);
  const noter = setInterval(note, NOTE_MS);
  first.unref();
  noter.unref();
  let timer: NodeJS.Timeout | undefined;
  const expired = Symbol("expired");
  const won = await Promise.race([granted, new Promise<typeof expired>((r) => (timer = setTimeout(() => r(expired), o.waitMs)))]);
  clearTimeout(timer);
  clearTimeout(first);
  clearInterval(noter);
  if (won !== expired) return won;
  if (release) return release; // granted in the same tick the clock ran out: take it
  lane.waiters = lane.waiters.filter((x) => x !== me);
  if (!lane.waiters.length && !lane.running && !lane.driving) dropTicket(lane);
  throw busyError(name, w, o.waitMs);
}
