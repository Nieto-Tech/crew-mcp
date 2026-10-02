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
//   1. In-process: a promise chain orders this process's calls, first come first served.
//   2. Cross-process: the head of that chain takes a ticket file in the lane's directory, and
//      the oldest live ticket holds the worker. A session's next call takes a fresh ticket, so it
//      goes behind other sessions already waiting: sessions take turns, a burst can't hog the GPU.
// A ticket is kept fresh by a heartbeat. One whose process is gone, or whose heartbeat stopped,
// is removed by whoever sees it, so a crashed session can't wedge the lane.

const POLL_MS = 250;
const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
/** How often a queued call reports where it stands. */
const NOTE_MS = 20_000;
/** A call starts only after it has been first in line, with nothing running, for this long: long enough for a ticket
 *  named a moment before ours, but published a moment after, to show up. */
const SETTLE_MS = 15;
/** Used for the wait estimate when the usage log has no history for a tool yet. */
const DEFAULT_CALL_MS = 90_000;

/** Workers sharing a server share a lane (two entries pointing at one Ollama are one GPU). */
export const laneKey = (w: WorkerConfig) =>
  `${w.provider}:${(w.baseUrl || (w.provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com/v1")).replace(/\/$/, "")}`;

export const lanesDir = () => path.join(path.dirname(usageLogPath()), "lanes");
const laneDir = (w: WorkerConfig) => path.join(lanesDir(), laneKey(w).replace(/[^A-Za-z0-9.-]+/g, "_"));

interface MemLane {
  tail: Promise<void>;
  running: number;
  waiting: number;
}
const mem = new Map<string, MemLane>();
const memLane = (w: WorkerConfig) => {
  const key = laneKey(w);
  let lane = mem.get(key);
  if (!lane) mem.set(key, (lane = { tail: Promise.resolve(), running: 0, waiting: 0 }));
  return lane;
};

interface TicketData {
  pid: number;
  host: string;
  /** Repo directory name only, as in the usage log. */
  workspace: string;
  tool: string;
  queuedAt: number;
  startedAt?: number;
}
interface Ticket extends Partial<TicketData> {
  file: string;
  pid: number;
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

/** Live tickets, oldest first. Stale ones are removed on the way. Throws if the directory can't be read. */
function liveTickets(dir: string): Ticket[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => TICKET.test(n)).sort();
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
    const pid = Number(TICKET.exec(name)![2]);
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
    out.push({ ...data, file, pid, mtimeMs });
  }
  return out;
}

/* ---------- what the queue looks like, and how long it will take ---------- */

export interface LaneView {
  running: number;
  waiting: number;
  holder?: { tool?: string; workspace?: string; heldMs: number; thisSession: boolean };
  /** Tools of the calls waiting, oldest first (undefined where unknown). */
  queued: (string | undefined)[];
}

export function laneView(w: WorkerConfig): LaneView {
  const m = memLane(w);
  let tickets: Ticket[] = [];
  try {
    tickets = liveTickets(laneDir(w));
  } catch {
    /* unreadable: fall back to this process's counts */
  }
  if (!tickets.length) {
    // No ticket files (nothing running anywhere, or the state dir is unusable): this process's counts are all there is.
    return { running: m.running, waiting: m.waiting, queued: Array(m.waiting).fill(undefined) };
  }
  // The holder is the call that has started, if one has; otherwise the head of the line, about to.
  const h = tickets.find((t) => t.startedAt) ?? tickets[0];
  const rest = tickets.filter((t) => t !== h);
  return {
    running: 1,
    waiting: rest.length + m.waiting,
    holder: { tool: h.tool, workspace: h.workspace, heldMs: Date.now() - (h.startedAt ?? h.queuedAt ?? h.mtimeMs), thisSession: h.pid === process.pid },
    queued: [...rest.map((t) => t.tool), ...Array(m.waiting).fill(undefined)],
  };
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

/** Rough time until `ahead` queued calls (plus the holder) are done. From past calls; an estimate, not a promise. */
export function estimateWaitMs(v: LaneView, worker: string, ahead = v.queued.length): number {
  if (!v.running) return 0;
  const t = typicalMs(worker);
  const of = (tool?: string) => (tool && t.byTool.get(tool)) || t.all;
  const holderLeft = Math.max(15_000, of(v.holder?.tool) - (v.holder?.heldMs ?? 0));
  return holderLeft + v.queued.slice(0, ahead).reduce((s, tool) => s + of(tool), 0);
}

const roughly = (ms: number) => (ms < 60_000 ? "under a minute" : `~${Math.round(ms / 60_000)} min`);

/** "crew_recon for oyedev-hub, 1m05s so far" */
export function describeHolder(v: LaneView): string {
  const h = v.holder;
  if (!h) return v.running ? "another call from this session" : "nothing";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Wait for the worker, then hold it until the returned release is called. Waits at most `waitMs`
 * in all (both layers), then throws. `onWait` gets a line about the queue now and then while waiting.
 */
export async function acquire(
  w: WorkerConfig,
  name: string,
  o: { waitMs: number; workspace: string; tool: string; onWait?: (msg: string) => void }
): Promise<() => void> {
  const deadline = Date.now() + o.waitMs;
  const label = w.label || name;
  const note = () => {
    try {
      const v = laneView(w);
      if (v.running) o.onWait?.(`${label} is busy (${describeHolder(v)}; ${v.waiting} waiting). Queued, est. wait ${roughly(estimateWaitMs(v, name))}…`);
    } catch (e: any) {
      log(`lane: queue note failed (${e?.message || e})`); // a progress note must never break the wait
    }
  };
  watchClock();
  note();
  const noter = setInterval(note, NOTE_MS);
  noter.unref();

  // Layer 1: this process's calls, in order.
  const lane = memLane(w);
  const prev = lane.tail;
  let releaseMem!: () => void;
  lane.tail = new Promise<void>((r) => (releaseMem = r));
  lane.waiting++;
  let timer: NodeJS.Timeout | undefined;
  const expired = Symbol("expired");
  const won = await Promise.race([prev, new Promise<typeof expired>((r) => (timer = setTimeout(() => r(expired), Math.max(0, deadline - Date.now()))))]);
  clearTimeout(timer);
  lane.waiting--;
  if (won === expired) {
    clearInterval(noter);
    // Give up our place, but keep the chain intact: whoever queued behind us still waits on `prev`.
    prev.then(() => releaseMem());
    throw busyError(name, w, o.waitMs);
  }

  // Layer 2: every crew process on this machine.
  const dir = laneDir(w);
  let file: string | undefined;
  let beat: NodeJS.Timeout | undefined;
  const data: TicketData = { pid: process.pid, host: os.hostname(), workspace: o.workspace, tool: o.tool, queuedAt: Date.now() };
  const take = () => {
    if (file) removeTicket(file);
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${String(Date.now()).padStart(15, "0")}-${process.pid}-${seq++}.json`);
    writeTicket(file, data);
  };
  /** Never throws: a ticket left behind goes stale and is removed by the next process that looks. */
  const drop = () => {
    clearInterval(beat);
    try {
      if (file) removeTicket(file);
    } catch (e: any) {
      log(`lane: ticket not removed (${e?.message || e}); it goes stale in ${STALE_MS / 1000}s`);
    }
    file = undefined;
  };
  try {
    take();
    beat = setInterval(() => {
      try {
        if (file) fs.utimesSync(file, new Date(), new Date());
      } catch {
        /* gone: the wait loop notices and takes a new one */
      }
    }, HEARTBEAT_MS);
    beat.unref();
    let firstSince = 0; // when we were first seen at the head of the line with nothing running
    for (;;) {
      const live = liveTickets(dir);
      const i = live.findIndex((t) => t.file === file);
      // Our ticket was removed as stale (this process was suspended past STALE_MS): take a new one, at the back.
      if (i < 0) take();
      // A call that already started holds the worker even if its ticket sorts after ours.
      if (i === 0 && !live.some((t) => t.startedAt && t.file !== file)) {
        if (!firstSince) firstSince = Date.now();
        else if (Date.now() - firstSince >= SETTLE_MS) break;
      } else firstSince = 0;
      if (Date.now() >= deadline) {
        drop();
        clearInterval(noter);
        releaseMem();
        throw busyError(name, w, o.waitMs);
      }
      await sleep(Math.min(firstSince ? SETTLE_MS : POLL_MS, Math.max(1, deadline - Date.now())));
    }
    writeTicket(file!, { ...data, startedAt: Date.now() });
  } catch (e: any) {
    if (/is busy/.test(e?.message)) throw e;
    // The state dir is unusable: carry on with this process's queue only, rather than fail the call.
    drop();
    log(`lane: cross-session queue unavailable (${e?.message || e}); queueing within this session only for this call`);
  }
  clearInterval(noter);
  lane.running++;
  return () => {
    lane.running--;
    drop();
    releaseMem();
  };
}
