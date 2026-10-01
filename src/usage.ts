import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./log.js";

/**
 * Usage log: one JSON line per model call, so `crew_stats` can say what stayed
 * local and what went to ChatGPT. Metadata only: no prompts, no code, no answers
 * (those of a reformat turn go to the separate reformat log below).
 */

export type Outcome = "ok" | "partial" | "unstructured" | "timeout" | "error";

export interface UsageEntry {
  ts: string; // ISO 8601
  tool: string;
  worker: string;
  provider: string;
  model?: string;
  /** True for workers on this machine (ollama, localhost servers). */
  local: boolean;
  /** Repo directory name only, never the full path. */
  workspace: string;
  wallSeconds: number;
  turns?: number;
  toolCalls?: number;
  filesRead: number;
  /** Characters of repository text the worker read (counted against its read budget). */
  charsRead: number;
  /** Tokens generated, when the server reports them. */
  tokens?: number;
  outcome: Outcome;
  quoteChecked?: number;
  unverified?: number;
  /** The reformat turn's outcome, when one ran. Its text is in the reformat log, never here. */
  reformat?: "ok" | "failed" | "rejected";
}

export function usageLogPath(): string {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "crew", "usage.jsonl");
}

/** Append one entry. Never throws: stats must not break a review. */
export function recordUsage(entry: UsageEntry, file = usageLogPath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch (e: any) {
    log(`usage log not written: ${e?.message || e}`);
  }
}

/**
 * Reformat log: next to the usage log, one JSON line per reformat turn, holding the raw answer and the reformat's
 * reply so a later look can see what the reformat changed. Unlike the usage log this has answer text, which can quote
 * repository code, so it is created owner-only. It joins to the usage entry on `ts` + `tool`.
 */
export interface ReformatEntry {
  ts: string;
  tool: string;
  worker: string;
  model?: string;
  workspace: string;
  outcome: "ok" | "failed" | "rejected";
  introduced?: string;
  raw: string;
  reformatted: string;
}

export const reformatLogPath = (usageFile = usageLogPath()) => path.join(path.dirname(usageFile), "reformats.jsonl");

/** Append one entry. Never throws. */
export function recordReformat(entry: ReformatEntry, file = reformatLogPath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (e: any) {
    log(`reformat log not written: ${e?.message || e}`);
  }
}

/** Read entries, skipping lines that don't parse (a crash mid-write can leave one). */
export function readUsage(file = usageLogPath()): UsageEntry[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.ts === "string" && typeof e.worker === "string") out.push(e);
    } catch {
      /* skip */
    }
  }
  return out;
}

export type Period = "today" | "week" | "all";

/** Entries in the period: "today" is since local midnight, "week" the last 7 days. */
export function inPeriod(entries: UsageEntry[], period: Period, now = new Date()): UsageEntry[] {
  if (period === "all") return entries;
  const since = new Date(now);
  if (period === "today") since.setHours(0, 0, 0, 0);
  else since.setTime(now.getTime() - 7 * 24 * 3600 * 1000);
  return entries.filter((e) => Date.parse(e.ts) >= since.getTime());
}

export interface WorkerTotals {
  worker: string;
  provider: string;
  model?: string;
  local: boolean;
  calls: number;
  failed: number;
  seconds: number;
  filesRead: number;
  charsRead: number;
  tokens: number;
  quoteChecked: number;
  unverified: number;
}

export function aggregate(entries: UsageEntry[]): WorkerTotals[] {
  const by = new Map<string, WorkerTotals>();
  for (const e of entries) {
    let t = by.get(e.worker);
    if (!t) {
      t = { worker: e.worker, provider: e.provider, model: e.model, local: !!e.local, calls: 0, failed: 0, seconds: 0, filesRead: 0, charsRead: 0, tokens: 0, quoteChecked: 0, unverified: 0 };
      by.set(e.worker, t);
    }
    t.calls++;
    if (e.outcome === "timeout" || e.outcome === "error") t.failed++;
    t.seconds += e.wallSeconds || 0;
    t.filesRead += e.filesRead || 0;
    t.charsRead += e.charsRead || 0;
    t.tokens += e.tokens || 0;
    t.quoteChecked += e.quoteChecked || 0;
    t.unverified += e.unverified || 0;
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls || a.worker.localeCompare(b.worker));
}

/** Characters read by local workers ÷ 4. A rough stand-in for text Claude didn't have to read. */
export function estimateKeptTokens(totals: WorkerTotals[]): number {
  return Math.round(totals.filter((t) => t.local).reduce((n, t) => n + t.charsRead, 0) / 4);
}

const n = (x: number) => x.toLocaleString("en-US");

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return s === 60 ? `${m + 1}m00s` : `${m}m${String(s).padStart(2, "0")}s`;
}

const PERIOD_LABEL: Record<Period, string> = { today: "today", week: "last 7 days", all: "all time" };

export function formatStats(entries: UsageEntry[], period: Period): string {
  const rows = inPeriod(entries, period);
  const label = PERIOD_LABEL[period];
  if (!rows.length) return `# crew usage, ${label}\nNo crew calls recorded${period === "all" ? "" : " in this period"}. Log: ${usageLogPath()}`;
  const totals = aggregate(rows);
  const out = [`# crew usage, ${label}`, `${n(rows.length)} call(s), ${fmtDuration(totals.reduce((s, t) => s + t.seconds, 0))} total worker time.`, ""];
  for (const t of totals) {
    const head = `**${t.worker}** (${t.provider}${t.model ? `, ${t.model}` : ""}, ${t.local ? "local" : "cloud"})`;
    const fails = t.failed ? `, ${t.failed} failed` : "";
    if (t.local) {
      out.push(
        `- ${head}: ${n(t.calls)} call(s)${fails} · ${fmtDuration(t.seconds)} · ${n(t.filesRead)} files read · ${n(t.charsRead)} chars read · ${n(t.tokens)} tokens generated · findings: ${n(t.quoteChecked)} quote-checked, ${n(t.unverified)} unverified`
      );
    } else {
      // Cloud workers read the repo on their side and report no usage, so only calls and time are known.
      out.push(`- ${head}: ${n(t.calls)} call(s)${fails} · ${fmtDuration(t.seconds)} (calls and time only; usage on that side is not measured)`);
    }
  }
  out.push("", `ESTIMATE: context kept out of Claude ≈ ${n(estimateKeptTokens(totals))} tokens (characters read by local workers ÷ 4). This is a rough estimate, not a measurement; crew cannot see Claude's own token use.`);
  return out.join("\n");
}

/** One line for crew_status. */
export function todayLine(entries: UsageEntry[], now = new Date()): string {
  const rows = inPeriod(entries, "today", now);
  if (!rows.length) return "today: no crew calls yet";
  const totals = aggregate(rows);
  const local = totals.filter((t) => t.local);
  const cloud = totals.filter((t) => !t.local);
  const sum = (ts: WorkerTotals[], f: (t: WorkerTotals) => number) => ts.reduce((s, t) => s + f(t), 0);
  const parts = [`${n(rows.length)} call(s)`];
  if (local.length) parts.push(`local ${n(sum(local, (t) => t.calls))} (${fmtDuration(sum(local, (t) => t.seconds))})`);
  if (cloud.length) parts.push(`cloud ${n(sum(cloud, (t) => t.calls))} (${fmtDuration(sum(cloud, (t) => t.seconds))})`);
  parts.push(`≈${n(estimateKeptTokens(totals))} tokens kept out of Claude (estimate)`);
  return `today: ${parts.join(" · ")}`;
}
