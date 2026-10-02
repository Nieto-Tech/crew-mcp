import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ProviderKind = "ollama" | "openai" | "codex-cli";

export interface WorkerConfig {
  provider: ProviderKind;
  label?: string;
  model?: string;
  /** ollama: http://localhost:11434 · openai: https://api.openai.com/v1 or any compatible server */
  baseUrl?: string;
  /** openai: name of the env var holding the API key (never the key itself) */
  apiKeyEnv?: string;
  /** ollama: context window requested on every call */
  numCtx?: number;
  timeoutMs?: number;
  /** Local workers: max time a call waits in the queue for the worker, shared by every crew session on the machine (default 600000). */
  queueWaitMs?: number;
  /** Total characters of tool output the model may read per task. Defaults from numCtx. */
  readBudgetChars?: number;
  maxTurns?: number;
  /** ollama: let the model think on exploration turns (default false; thinking there is mostly discarded tokens). */
  thinkOnTools?: boolean;
  /** ollama: max tokens generated per exploration turn (default 2048). */
  numPredictTools?: number;
  /** ollama: max tokens for the final answer turn, thinking included (default 8192). */
  numPredictFinal?: number;
  /** ollama/openai: let the model think on the final answer turn (default true). Switch off if empty-answer retries are common. */
  thinkOnFinal?: boolean;
  /**
   * openai: how thinking is switched for llama.cpp's llama-server (and other servers that read the chat template).
   * "chat_template_kwargs" sends `chat_template_kwargs.enable_thinking` (false on exploration turns unless thinkOnTools,
   * on the final turn per thinkOnFinal); "none" (default) sends nothing.
   */
  thinkingParam?: "chat_template_kwargs" | "none";
  /** codex-cli: path to the codex binary (default "codex" on PATH) */
  codexPath?: string;
}

export interface CrewConfig {
  workers: Record<string, WorkerConfig>;
  roles: {
    /** recon + diff review: high volume, should be cheap (local GPU first) */
    scout: string[];
    /** independent second opinion: ideally a different, strong model */
    reviewer: string[];
  };
}

const DEFAULTS: CrewConfig = {
  workers: {
    local: {
      provider: "ollama",
      label: "Local GPU (Ollama)",
      baseUrl: "http://localhost:11434",
      model: "qwen3.8:27b",
      numCtx: 65536,
      timeoutMs: 300_000,
    },
    chatgpt: {
      provider: "codex-cli",
      label: "ChatGPT (Codex CLI)",
      timeoutMs: 600_000,
    },
  },
  roles: {
    scout: ["local", "chatgpt"],
    reviewer: ["chatgpt"],
  },
};

function readJson(file: string): Partial<CrewConfig> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`Bad crew config ${file}: ${e.message}`);
  }
}

function merge(base: CrewConfig, over: Partial<CrewConfig> | null): CrewConfig {
  if (!over) return base;
  const workers: Record<string, WorkerConfig> = {};
  for (const [name, w] of Object.entries(base.workers)) workers[name] = { ...w };
  for (const [name, w] of Object.entries(over.workers || {})) {
    workers[name] = { ...(workers[name] || {}), ...w } as WorkerConfig;
  }
  return {
    workers,
    roles: {
      scout: over.roles?.scout || base.roles.scout,
      reviewer: over.roles?.reviewer || base.roles.reviewer,
    },
  };
}

export const userConfigPath = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "crew", "config.json");

/**
 * Precedence (later wins): built-in defaults, ~/.config/crew/config.json
 * (personal, per machine), the CREW_CONFIG file, then env overrides.
 */
export function loadConfig(): { config: CrewConfig; sources: string[] } {
  const sources: string[] = ["defaults"];
  let config = merge(DEFAULTS, {});

  const user = readJson(userConfigPath());
  if (user) {
    config = merge(config, user);
    sources.push(userConfigPath());
  }

  if (process.env.CREW_CONFIG) {
    const extra = readJson(process.env.CREW_CONFIG);
    if (!extra) throw new Error(`CREW_CONFIG not found: ${process.env.CREW_CONFIG}`);
    config = merge(config, extra);
    sources.push(process.env.CREW_CONFIG);
  }

  // Quick overrides without editing files.
  const local = config.workers.local;
  if (local) {
    if (process.env.CREW_OLLAMA_MODEL) local.model = process.env.CREW_OLLAMA_MODEL;
    if (process.env.CREW_OLLAMA_URL) local.baseUrl = process.env.CREW_OLLAMA_URL;
    if (process.env.CREW_NUM_CTX) local.numCtx = Number(process.env.CREW_NUM_CTX);
  }
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.CREW_SCOUT) config.roles.scout = list(process.env.CREW_SCOUT);
  if (process.env.CREW_REVIEWER) config.roles.reviewer = list(process.env.CREW_REVIEWER);
  if (["CREW_SCOUT", "CREW_REVIEWER", "CREW_OLLAMA_MODEL", "CREW_OLLAMA_URL", "CREW_NUM_CTX"].some((k) => process.env[k])) {
    sources.push("env");
  }

  for (const [name, w] of Object.entries(config.workers)) {
    if (w.thinkingParam !== undefined && w.thinkingParam !== "chat_template_kwargs" && w.thinkingParam !== "none") {
      throw new Error(`Worker "${name}": thinkingParam must be "chat_template_kwargs" or "none" (got ${JSON.stringify(w.thinkingParam)})`);
    }
  }
  for (const role of ["scout", "reviewer"] as const) {
    for (const name of config.roles[role]) {
      if (!config.workers[name]) throw new Error(`Role "${role}" references unknown worker "${name}"`);
    }
  }
  return { config, sources };
}

export function budgetsFor(w: WorkerConfig) {
  // ~1.8 chars per token of context leaves room for prompt, thinking and answer.
  const readBudget =
    w.readBudgetChars ?? (w.provider === "ollama" ? Math.round((w.numCtx || 32768) * 1.8) : 200_000);
  return {
    readBudget,
    perRead: Math.max(4_000, Math.min(16_000, Math.round(readBudget / 6))),
    maxTurns: w.maxTurns ?? 16,
    timeoutMs: w.timeoutMs ?? 300_000,
    queueWaitMs: w.queueWaitMs ?? 600_000,
  };
}
