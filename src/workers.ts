import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { budgetsFor, userConfigPath, type CrewConfig, type WorkerConfig } from "./config.js";
import { acquire } from "./lane.js";
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

  // Serialize local workers, across every crew process on this machine. The timeout clock starts only once we hold the worker.
  const queuedAt = Date.now();
  const serialize = w.provider !== "codex-cli" && isLocalWorker(w);
  const release = serialize
    ? await acquire(w, name, { waitMs: b.queueWaitMs, workspace: path.basename(opts.ws.root), tool: opts.tool || opts.role, onWait: opts.onProgress })
    : () => {};
  const started = Date.now();
  const queuedMs = started - queuedAt;

  const budget = new Budget(b.readBudget, b.perRead);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), b.timeoutMs);
  const stats: AgentStats = { turns: 0, toolCalls: 0, modelMs: 0, evalTokens: 0, malformedRetries: 0 };

  // Everything from here on is inside the try, so the worker is always released.
  try {
    opts.onProgress?.(`${w.label || name} (${w.model || w.provider}) working…`);
    log(`${opts.role} → ${name}${skipped.length ? ` (skipped: ${skipped.join("; ")})` : ""}${queuedMs >= 100 ? ` (queued ${(queuedMs / 1000).toFixed(1)}s)` : ""}`);
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
