import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { budgetsFor, userConfigPath, type CrewConfig, type WorkerConfig } from "./config.js";
import { isLocalWorker, loadPolicy, policyReason, type Policy } from "./policy.js";
import { OllamaProvider, OpenAIProvider, diagLine, runAgent, type AgentStats, type AnswerSpec, type FinalRetry, type Reformat, type ReformatDetail } from "./agent.js";
import { runCodex } from "./codex.js";
import { launchSpec } from "./spawncmd.js";
import { Budget, Workspace } from "./workspace.js";
import { log } from "./log.js";
import { closestModels, findModel } from "./models.js";
import { recordUsage, type Outcome } from "./usage.js";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface Availability {
  ok: boolean;
  detail: string;
  /** ollama: the installed spelling of the configured model, when it differs only in tag case. */
  model?: string;
}

const cache = new Map<string, { at: number; a: Availability }>();

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))),
  ]).finally(() => clearTimeout(t));
}

/** Cheap health check so a role can fall through to the next worker. */
export async function checkWorker(name: string, w: WorkerConfig): Promise<Availability> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.a;

  let a: Availability;
  try {
    if (w.provider === "ollama") {
      const base = (w.baseUrl || "http://localhost:11434").replace(/\/$/, "");
      const res = await withTimeout(fetch(`${base}/api/tags`), 2_500);
      const data: any = await res.json();
      const names: string[] = (data.models || []).map((m: any) => m.name);
      const want = w.model || "";
      const found = findModel(names, want);
      // Only a real respelling (tag case) is sent as installed; "x" vs "x:latest" is the same name to Ollama.
      const respelled = !!found && found !== want && found !== `${want}:latest`;
      a = found
        ? respelled
          ? { ok: true, detail: `${found} @ ${base} (configured as ${want})`, model: found }
          : { ok: true, detail: `${want} @ ${base}` }
        : {
            ok: false,
            detail: `model "${want}" not pulled at ${base} (${names.length ? `closest installed: ${closestModels(names, want).join(", ")}` : "no models installed"})`,
          };
    } else if (w.provider === "openai") {
      const keyOk = !w.apiKeyEnv || !!process.env[w.apiKeyEnv];
      const base = (w.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
      if (!keyOk) a = { ok: false, detail: `env ${w.apiKeyEnv} is not set` };
      else if (!isLocalWorker(w)) a = { ok: true, detail: `${w.model} @ ${base}` };
      else {
        // A local server (llama-server, LM Studio) can simply be off: say so, so the role falls through to the next worker.
        // Any HTTP answer means it is up; only a failed connection means down.
        try {
          await withTimeout(fetch(`${base}/models`, { redirect: "error" }), 2_500);
          a = { ok: true, detail: `${w.model} @ ${base}` };
        } catch (e: any) {
          a = { ok: false, detail: `server not reachable at ${base} (${e.cause?.code || e.message})` };
        }
      }
    } else {
      const l = launchSpec(w.codexPath || "codex", ["--version"]);
      const { stdout } = await withTimeout(execFileAsync(l.command, l.args, { windowsVerbatimArguments: l.windowsVerbatimArguments }), 5_000);
      a = { ok: true, detail: `${stdout.trim()}${w.model ? ` (model ${w.model})` : ""}` };
    }
  } catch (e: any) {
    if (e?.code === "ENOENT") a = { ok: false, detail: "codex CLI not installed (npm i -g @openai/codex, then codex login)" };
    else if (w.provider === "ollama") a = { ok: false, detail: `Ollama not reachable at ${w.baseUrl || "http://localhost:11434"} (${e.message})` };
    else a = { ok: false, detail: e.message };
  }
  cache.set(name, { at: Date.now(), a });
  return a;
}

export async function resolveRole(config: CrewConfig, role: "scout" | "reviewer", policy?: Policy) {
  const tried: string[] = [];
  const excluded: string[] = [];
  for (const name of config.roles[role]) {
    const w = config.workers[name];
    // cloud:false is absolute: a cloud worker is never checked, never used, never a fallback.
    if (policy && !policy.cloud && !isLocalWorker(w)) {
      excluded.push(name);
      continue;
    }
    const a = await checkWorker(name, w);
    // Send the installed spelling to the server (Q4_K_M vs q4_K_M).
    if (a.ok) return { name, w: a.model && a.model !== w.model ? { ...w, model: a.model } : w, skipped: tried, excluded };
    tried.push(`${name}: ${a.detail}`);
  }
  if (policy && !policy.cloud) {
    throw new Error(
      `No LOCAL worker available for role "${role}", and ${policyReason(policy)} forbids cloud workers` +
        `${excluded.length ? ` (excluded: ${excluded.join(", ")})` : ""}. ` +
        `Not falling back. ${tried.length ? `Tried:\n- ${tried.join("\n- ")}\n` : `No local worker is in the "${role}" chain. `}` +
        `Start the local model or add a local worker to the role in ${userConfigPath()}. Run crew_status for details.`
    );
  }
  throw new Error(`No available worker for role "${role}". Tried:\n- ${tried.join("\n- ")}\nRun crew_status for details.`);
}

/* ---------- one request at a time per local worker ---------- */

// A local GPU can't usefully run two agent loops at once: they fight over the same
// model, and each one's clock would be burning while it waits. Later calls queue.
interface Lane {
  tail: Promise<void>;
  running: number;
  waiting: number;
  /** When the current holder got the worker. */
  busySince: number;
}
const lanes = new Map<string, Lane>();

/** Workers sharing a server share a lane (two entries pointing at one Ollama are one GPU). */
const laneKey = (w: WorkerConfig) =>
  `${w.provider}:${(w.baseUrl || (w.provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com/v1")).replace(/\/$/, "")}`;

export function laneStatus(w: WorkerConfig): { running: number; waiting: number } {
  const l = lanes.get(laneKey(w));
  return { running: l?.running ?? 0, waiting: l?.waiting ?? 0 };
}

async function acquire(w: WorkerConfig, name: string, waitMs: number): Promise<() => void> {
  const key = laneKey(w);
  let lane = lanes.get(key);
  if (!lane) lanes.set(key, (lane = { tail: Promise.resolve(), running: 0, waiting: 0, busySince: 0 }));
  const prev = lane.tail;
  let release!: () => void;
  lane.tail = new Promise<void>((r) => (release = r));
  lane.waiting++;
  let timer: NodeJS.Timeout | undefined;
  const expired = Symbol("expired");
  const won = await Promise.race([
    prev,
    new Promise<typeof expired>((r) => (timer = setTimeout(() => r(expired), waitMs))),
  ]);
  clearTimeout(timer);
  if (won === expired) {
    // Give up our place, but keep the chain intact: whoever queued behind us still waits on `prev`.
    const depth = lane.waiting;
    const busyFor = Math.round((Date.now() - lane.busySince) / 1000);
    lane.waiting--;
    prev.then(() => release());
    throw new Error(
      `Worker "${name}" is busy: gave up after waiting ${Math.round(waitMs / 1000)}s in the queue ` +
        `(${depth} waiting including this call; the current call has held the worker for ${busyFor}s). ` +
        `Fix: retry later, or raise queueWaitMs for "${name}" in ${userConfigPath()}.`
    );
  }
  lane.waiting--;
  lane.running++;
  lane.busySince = Date.now();
  return () => {
    lane!.running--;
    release();
  };
}

export interface TaskResult {
  text: string;
  worker: string;
  label: string;
  model?: string;
  ms: number;
  turns?: number;
  toolCalls?: number;
  /** Tokens generated across all turns, retries included, when the server reports it. */
  evalTokens?: number;
  filesRead: string[];
  provider: string;
  /** True when the worker runs on this machine. */
  local: boolean;
  /** Characters of repository text the worker read. */
  charsRead: number;
  skipped: string[];
  /** Time spent waiting for the worker before the call started (not in `ms`). */
  queuedMs: number;
  /** Set when the deadline cut exploration short. */
  partial?: string;
  /** Why the final answer was retried with thinking off, if it was. */
  finalRetry?: FinalRetry;
  /** Turns redone after Ollama rejected a malformed tool call. */
  malformedRetries?: number;
  /** Set when the final answer needed a reformat turn: "ok" if that produced the JSON it was allowed to keep. */
  reformat?: Reformat;
  /** The raw answer and the reformat's reply: for the side log, never the tool output. */
  reformatDetail?: ReformatDetail;
  /** One-line where-did-the-time-go summary (agent workers only). */
  diag?: string;
}

/** Share of the worker's timeout spent exploring; the rest is reserved for the answer. */
const EXPLORE_SHARE = 0.65;

export async function runTask(opts: {
  config: CrewConfig;
  role: "scout" | "reviewer";
  ws: Workspace;
  system: string;
  prompt: string;
  onProgress?: (msg: string) => void;
  policy?: Policy;
  /** Name of the crew tool making the call, for the usage log. */
  tool?: string;
  /** The JSON the answer must be; agent workers get one reformat turn if the answer doesn't parse. */
  answer?: AnswerSpec;
}): Promise<TaskResult> {
  // Load the policy here too, so no caller can reach a model without it being applied.
  const policy = opts.policy ?? loadPolicy(opts.ws.root);
  const { name, w, skipped } = await resolveRole(opts.config, opts.role, policy);
  const b = budgetsFor(w);

  // Serialize local workers. The timeout clock starts only once we hold the worker.
  const queuedAt = Date.now();
  const serialize = w.provider !== "codex-cli" && isLocalWorker(w);
  if (serialize && laneStatus(w).running) opts.onProgress?.(`${w.label || name} is busy, queued…`);
  const release = serialize ? await acquire(w, name, b.queueWaitMs) : () => {};
  const started = Date.now();
  const queuedMs = started - queuedAt;

  const budget = new Budget(b.readBudget, b.perRead);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), b.timeoutMs);
  const stats: AgentStats = { turns: 0, toolCalls: 0, modelMs: 0, evalTokens: 0, malformedRetries: 0 };
  opts.onProgress?.(`${w.label || name} (${w.model || w.provider}) working…`);
  log(`${opts.role} → ${name}${skipped.length ? ` (skipped: ${skipped.join("; ")})` : ""}${queuedMs >= 100 ? ` (queued ${(queuedMs / 1000).toFixed(1)}s)` : ""}`);

  try {
    if (w.provider === "codex-cli") {
      const text = await runCodex({
        w,
        cwd: opts.ws.root,
        prompt: `${opts.system}\n\n${opts.prompt}`,
        timeoutMs: b.timeoutMs,
        signal: ac.signal,
      });
      return { text, worker: name, label: w.label || name, model: w.model, ms: Date.now() - started, filesRead: [], provider: w.provider, local: isLocalWorker(w), charsRead: 0, skipped, queuedMs };
    }

    const provider = w.provider === "ollama" ? new OllamaProvider(w) : new OpenAIProvider(w);
    const r = await runAgent({
      provider,
      ws: opts.ws,
      system: opts.system,
      prompt: opts.prompt,
      budget,
      maxTurns: b.maxTurns,
      signal: ac.signal,
      softDeadline: started + b.timeoutMs * EXPLORE_SHARE,
      stats,
      answer: opts.answer,
      onProgress: opts.onProgress,
      onLog: log,
    });
    return {
      text: r.text,
      worker: name,
      label: w.label || name,
      model: w.model,
      ms: Date.now() - started,
      turns: r.turns,
      toolCalls: r.toolCalls,
      evalTokens: stats.evalTokens || undefined,
      filesRead: r.filesRead,
      provider: w.provider,
      local: isLocalWorker(w),
      charsRead: budget.used,
      skipped,
      queuedMs,
      partial: r.partial,
      finalRetry: r.finalRetry,
      malformedRetries: r.malformedRetries || undefined,
      reformat: r.reformat,
      reformatDetail: r.reformatDetail,
      diag: diagLine(stats, queuedMs),
    };
  } catch (e: any) {
    recordUsage({
      ts: new Date().toISOString(),
      tool: opts.tool || opts.role,
      worker: name,
      provider: w.provider,
      model: w.model,
      local: isLocalWorker(w),
      workspace: path.basename(opts.ws.root),
      wallSeconds: Math.round(Date.now() - started) / 1000,
      turns: stats.turns || undefined,
      toolCalls: stats.toolCalls || undefined,
      filesRead: 0,
      charsRead: budget.used,
      tokens: stats.evalTokens || undefined,
      outcome: (ac.signal.aborted ? "timeout" : "error") satisfies Outcome,
    });
    if (ac.signal.aborted) {
      const secs = b.timeoutMs < 10_000 ? (b.timeoutMs / 1000).toFixed(1) : Math.round(b.timeoutMs / 1000);
      throw new Error(
        `Worker "${name}" (${w.label || w.model || w.provider}) timed out after ${secs}s` +
          `${w.provider === "codex-cli" ? "" : ` (${diagLine(stats, queuedMs)})`}. ` +
          `Fix: narrow the request with \`paths\`, or raise timeoutMs for "${name}" in ${userConfigPath()}.`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
    release();
  }
}
