import { Budget, Workspace } from "./workspace.js";
import { extractJson, introducedBy } from "./checks.js";
import type { WorkerConfig } from "./config.js";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface ChatReply {
  content: string;
  toolCalls: ToolCall[];
  /** Tokens the model generated this turn (thinking included), when the server reports it. */
  evalCount?: number;
  /** The reply was cut off by the token limit. */
  truncated?: boolean;
  /** The server returned non-empty reasoning in a separate `thinking` field. */
  hadThinking?: boolean;
  /** The server's stop reason (Ollama done_reason / OpenAI finish_reason). */
  doneReason?: string;
}

export interface ChatProvider {
  /** True when a final turn can be re-asked with thinking off and get a different result. */
  readonly canDropThinking?: boolean;
  /**
   * `final` = the answer turn: tools removed, thinking allowed, bigger token cap. `noThink` forces thinking off (the
   * empty-answer retry). `numPredict` caps this turn's output (the reformat turn), never above the final-turn cap.
   */
  chat(messages: ChatMessage[], tools: ToolSpec[] | undefined, signal: AbortSignal, final: boolean, noThink?: boolean, numPredict?: number): Promise<ChatReply>;
}

export type FinalRetry = "empty" | "cut-off";

/** The JSON a task's answer must be: the schema as the prompt shows it, and the check its parser applies. */
export interface AnswerSpec {
  schema: string;
  isValid: (v: any) => boolean;
}

/**
 * Outcome of the reformat turn: re-emitted as valid JSON ("ok"), still not valid ("failed"), or valid but carrying a
 * path or evidence quote the raw answer didn't have ("rejected").
 */
export type Reformat = "ok" | "failed" | "rejected";
export const reformatNote = (r: Reformat) => (r === "ok" ? "reformatted" : `reformat ${r}`);

/** What the reformat turn was given and gave back, kept for the side log (never the tool output). */
export interface ReformatDetail {
  raw: string;
  reply: string;
  /** For "rejected": the path, or the quoted evidence, the reformat introduced. */
  introduced?: string;
}

export const REFORMAT_INSTRUCTION = "Return only this content as JSON matching the schema; add nothing, drop nothing.";
const reformatPrompt = (schema: string, raw: string) =>
  `${REFORMAT_INSTRUCTION}\n\nSchema:\n${schema}\n\n===== CONTENT =====\n${raw}\n===== END CONTENT =====`;
/** Room to re-emit the answer as JSON (JSON runs denser than prose: allow 2 chars a token, plus slack); the provider clamps it to the final-turn cap. */
export const reformatNumPredict = (raw: string) => 512 + Math.ceil(raw.length / 2);

/** Ollama could not parse the model's tool call (HTTP 500, e.g. "XML syntax error ... <parameter> closed by </function>"). */
export class ToolCallParseError extends Error {}

const TOOL_PARSE_RE = /xml syntax error|(?:error|failed) (?:parsing|to parse) tool[ _-]?call|<\/?(?:parameter|function|tool_call)>/i;
export const isToolCallParseFailure = (status: number, body: string) => status === 500 && TOOL_PARSE_RE.test(body);

export const MALFORMED_NOTE = "malformed tool call retried";
/** Malformed tool calls redone per task, each with the nudge; one more fails the task. */
export const MAX_MALFORMED_RETRIES = 2;
const malformedNudge = (toolsAvailable: boolean) =>
  toolsAvailable
    ? "Your previous tool call was malformed and could not be parsed. Call the tool again using valid tool-call syntax: " +
      "a single well-formed call with its arguments as a proper JSON object. If you no longer need a tool, give your final answer instead."
    : "Your previous reply contained a malformed tool call and could not be parsed. No tools are available now: do not call any, " +
      "give your final answer as plain text in the exact format the task requires.";

export const finalRetryNote = (r: FinalRetry) =>
  r === "cut-off" ? "final answer was cut off; retried without thinking" : "final answer retried without thinking";

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const stripThink = (s: string) => String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

/* ---------- Ollama (/api/chat, native tool calling) ---------- */

export class OllamaProvider implements ChatProvider {
  constructor(private w: WorkerConfig) {}

  get canDropThinking() {
    return this.w.thinkOnFinal !== false;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[] | undefined, signal: AbortSignal, final: boolean, noThink = false, numPredict?: number): Promise<ChatReply> {
    const finalCap = this.w.numPredictFinal ?? 8192;
    const body: any = {
      model: this.w.model,
      stream: false,
      keep_alive: "1h",
      options: {
        num_ctx: this.w.numCtx || 32768,
        num_predict: numPredict ? Math.min(numPredict, finalCap) : final ? finalCap : this.w.numPredictTools ?? 2048,
      },
      tools,
      messages: messages.map((m) => {
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.content,
            tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })),
          };
        }
        if (m.role === "tool") return { role: "tool", tool_name: m.toolName, content: m.content };
        return { role: m.role, content: m.content };
      }),
    };
    // Exploration turns: no thinking by default (it is thrown away). The answer turn uses the model's default,
    // unless thinkOnFinal is false or this is the retry of an empty answer.
    if (!final) body.think = this.w.thinkOnTools ?? false;
    else if (noThink || this.w.thinkOnFinal === false) body.think = false;
    const res = await fetch(`${(this.w.baseUrl || "http://localhost:11434").replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
      redirect: "error", // never let a local endpoint bounce the prompt to another host
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      const msg = `Ollama ${res.status}: ${errText}`;
      throw isToolCallParseFailure(res.status, errText) ? new ToolCallParseError(msg) : new Error(msg);
    }
    const data: any = await res.json();
    const msg = data.message || {};
    return {
      content: stripThink(msg.content),
      toolCalls: (msg.tool_calls || []).map((c: any, i: number) => ({
        id: c.id || `call_${i}`,
        name: c.function?.name,
        args: parseArgs(c.function?.arguments),
      })),
      evalCount: typeof data.eval_count === "number" ? data.eval_count : undefined,
      truncated: data.done_reason === "length",
      hadThinking: typeof msg.thinking === "string" && msg.thinking.trim().length > 0,
      doneReason: typeof data.done_reason === "string" ? data.done_reason : undefined,
    };
  }
}

/* ---------- OpenAI-compatible (/chat/completions) ---------- */
// Works for the OpenAI API and local servers that speak the same protocol
// (LM Studio, llama.cpp server, vLLM, Ollama's /v1).

export class OpenAIProvider implements ChatProvider {
  constructor(private w: WorkerConfig) {}

  /** A final turn can be re-asked without thinking only if this worker can switch thinking off. */
  get canDropThinking() {
    return this.w.thinkingParam === "chat_template_kwargs" && this.w.thinkOnFinal !== false;
  }

  /** enable_thinking for this turn, or undefined when this worker doesn't control it. Mirrors the Ollama rules. */
  private enableThinking(final: boolean, noThink: boolean): boolean | undefined {
    if (this.w.thinkingParam !== "chat_template_kwargs") return undefined;
    if (!final) return this.w.thinkOnTools ?? false;
    return !(noThink || this.w.thinkOnFinal === false);
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[] | undefined, signal: AbortSignal, final: boolean, noThink = false, numPredict?: number): Promise<ChatReply> {
    const key = this.w.apiKeyEnv ? process.env[this.w.apiKeyEnv] : undefined;
    const body: any = {
      model: this.w.model,
      messages: messages.map((m) => {
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          };
        }
        if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        return { role: m.role, content: m.content };
      }),
    };
    if (tools) body.tools = tools;
    // Only the reformat turn sets a cap here; other turns leave it to the server, as before.
    if (numPredict) body.max_tokens = this.w.numPredictFinal ? Math.min(numPredict, this.w.numPredictFinal) : numPredict;
    const think = this.enableThinking(final, noThink);
    if (think !== undefined) body.chat_template_kwargs = { enable_thinking: think };

    const res = await fetch(`${(this.w.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (!res.ok) throw new Error(`OpenAI-compatible API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message || {};
    return {
      content: stripThink(msg.content || ""),
      toolCalls: (msg.tool_calls || []).map((c: any, i: number) => ({
        id: c.id || `call_${i}`,
        name: c.function?.name,
        args: parseArgs(c.function?.arguments),
      })),
      evalCount: typeof data.usage?.completion_tokens === "number" ? data.usage.completion_tokens : undefined,
      truncated: data.choices?.[0]?.finish_reason === "length",
      hadThinking: [msg.reasoning_content, msg.reasoning].some((r) => typeof r === "string" && r.trim().length > 0),
      doneReason: data.choices?.[0]?.finish_reason ?? undefined,
    };
  }
}

/* ---------- Read-only repository tools ---------- */

export const REPO_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Regex search across the repository (ripgrep). Returns file:line:match. Use FIRST to find symbols.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex, e.g. 'constructEvent|webhook'" },
          path: { type: "string", description: "Optional subdirectory relative to the repo root" },
          maxPerFile: { type: "number", description: "Max matches per file (default 5)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List repository files, optionally under a path and/or filtered by a substring.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Subdirectory relative to the repo root" },
          filter: { type: "string", description: "Case-insensitive substring, e.g. 'webhook'" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file with line numbers. Use startLine/endLine for big files; output is capped.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["path"],
      },
    },
  },
];

const clip = (text: string, max: number, what: string) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf("\n"))}\n[TRUNCATED ${what}: narrow the pattern or path]`;
};

async function runRepoTool(ws: Workspace, budget: Budget, call: ToolCall, filesRead: Set<string>): Promise<string> {
  const a = call.args;
  switch (call.name) {
    case "search_code": {
      if (typeof a.pattern !== "string" || !a.pattern.trim()) throw new Error("pattern is required");
      const out = await ws.search(a.pattern, typeof a.path === "string" ? a.path : ".", Number(a.maxPerFile) || 5);
      return budget.spend(out.trim() ? clip(out, 8_000, "search output") : "No matches.");
    }
    case "list_files": {
      const prefix = typeof a.path === "string" && a.path !== "." ? ws.rel(await ws.resolve(a.path)) : "";
      const filter = typeof a.filter === "string" ? a.filter.toLowerCase() : "";
      const files = (await ws.listFiles())
        .filter((f) => !prefix || f === prefix || f.startsWith(`${prefix}/`))
        .filter((f) => !filter || f.toLowerCase().includes(filter));
      const more = files.length > 300 ? `\n[${files.length - 300} more; narrow path or filter]` : "";
      return budget.spend(files.length ? files.slice(0, 300).join("\n") + more : "No files.");
    }
    case "read_file": {
      if (typeof a.path !== "string") throw new Error("path is required");
      if (budget.left <= 0) return budget.spend("");
      const real = await ws.resolve(a.path);
      filesRead.add(ws.rel(real));
      const text = await ws.readFile(a.path, {
        startLine: a.startLine == null ? undefined : Number(a.startLine),
        endLine: a.endLine == null ? undefined : Number(a.endLine),
        maxChars: Math.min(budget.perRead, budget.left),
      });
      return budget.spend(text) + `\n[read budget remaining: ~${Math.round(budget.left / 1000)}K chars]`;
    }
    default:
      return `Unknown tool "${call.name}". Available: search_code, list_files, read_file`;
  }
}

export interface AgentResult {
  text: string;
  turns: number;
  toolCalls: number;
  filesRead: string[];
  /** Set when the deadline cut exploration short, e.g. "stopped exploring at 195s". */
  partial?: string;
  /** Why the final answer was retried with thinking off, if it was. */
  finalRetry?: FinalRetry;
  /** Turns redone after Ollama rejected a malformed tool call. */
  malformedRetries: number;
  /** Set when the final answer wasn't the task's JSON and one reformat turn was run. */
  reformat?: Reformat;
  reformatDetail?: ReformatDetail;
}

/** Filled in as the loop runs, so a timeout can still report where the time went. */
export interface AgentStats {
  turns: number;
  toolCalls: number;
  /** Time spent waiting on the model (not on repo tools). */
  modelMs: number;
  evalTokens: number;
  /** Why the final answer was retried without thinking, if it was. */
  finalRetry?: FinalRetry;
  /** Turns redone after Ollama rejected a malformed tool call. */
  malformedRetries: number;
  /** Set when the final answer wasn't the task's JSON and one reformat turn was run. */
  reformat?: Reformat;
}

const secs = (ms: number) => (ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000)));

/** One line that tells thinking from queueing from context growth. */
export function diagLine(s: AgentStats, queuedMs: number): string {
  return (
    `${s.turns} turn${s.turns === 1 ? "" : "s"}, ${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"}, ` +
    `${secs(s.modelMs)}s in model generation, ${secs(queuedMs)}s queued` +
    (s.evalTokens ? `, ${s.evalTokens.toLocaleString("en-US")} tokens generated` : "") +
    (s.finalRetry ? `, ${finalRetryNote(s.finalRetry)}` : "") +
    (s.malformedRetries ? `, ${MALFORMED_NOTE}${s.malformedRetries > 1 ? ` ×${s.malformedRetries}` : ""}` : "") +
    (s.reformat ? `, ${reformatNote(s.reformat)}` : "")
  );
}

const messageChars = (m: ChatMessage[]) => m.reduce((n, x) => n + x.content.length, 0);

/**
 * Tool loop we fully control: the task message is never dropped or rewritten,
 * every tool result is charged to the budget, and the final turn removes the
 * tools so the model has to answer. That final turn is forced by the turn cap, the
 * read budget, or the soft deadline (so a slow model returns a partial answer, not a timeout).
 */
export async function runAgent(opts: {
  provider: ChatProvider;
  ws: Workspace;
  system: string;
  prompt: string;
  budget: Budget;
  maxTurns: number;
  signal: AbortSignal;
  /** Epoch ms after which the next turn is the forced final one. */
  softDeadline?: number;
  stats?: AgentStats;
  /** The JSON the answer must be. When set, an answer that doesn't parse gets one reformat turn. */
  answer?: AnswerSpec;
  onProgress?: (msg: string) => void;
  onLog?: (msg: string) => void;
}): Promise<AgentResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.prompt },
  ];
  const filesRead = new Set<string>();
  const stats = opts.stats ?? { turns: 0, toolCalls: 0, modelMs: 0, evalTokens: 0, malformedRetries: 0 };

  // A model that writes a broken tool call makes Ollama answer 500. Redo that turn with a nudge, up to
  // MAX_MALFORMED_RETRIES times per task (not per turn); one more and the error surfaces and the task fails.
  const ask = async (tools: ToolSpec[] | undefined, final: boolean, noThink?: boolean): Promise<ChatReply> => {
    // A one-off copy on a retry: the nudge is not left in the history for later turns.
    let sent: ChatMessage[] = messages;
    for (;;) {
      try {
        return await opts.provider.chat(sent, tools, opts.signal, final, noThink);
      } catch (e) {
        if (!(e instanceof ToolCallParseError) || stats.malformedRetries >= MAX_MALFORMED_RETRIES) throw e;
        stats.malformedRetries++;
        opts.onLog?.(`${MALFORMED_NOTE} (${stats.malformedRetries}/${MAX_MALFORMED_RETRIES}): ${e.message}`);
        sent = [...messages, { role: "user", content: malformedNudge(!!tools) }];
      }
    }
  };
  const started = Date.now();
  let partial: string | undefined;
  let forceFinal = false;

  for (let turn = 1; ; turn++) {
    const capped = turn >= opts.maxTurns || opts.budget.left <= 0;
    const pastDeadline = opts.softDeadline !== undefined && Date.now() >= opts.softDeadline;
    const finalTurn = forceFinal || capped || pastDeadline;
    if (pastDeadline && !capped && !forceFinal) partial = `stopped exploring at ${secs(Date.now() - started)}s (time limit)`;
    if (finalTurn && messages[messages.length - 1].role === "tool") {
      messages.push({
        role: "user",
        content: "Stop exploring now. Using only what you have gathered, give your final answer in the exact format the task requires.",
      });
    }

    const t0 = Date.now();
    let reply: ChatReply;
    try {
      reply = await ask(finalTurn ? undefined : REPO_TOOLS, finalTurn);
    } finally {
      stats.modelMs += Date.now() - t0;
      stats.turns = turn;
    }
    stats.evalTokens += reply.evalCount || 0;

    if (finalTurn) {
      opts.onLog?.(
        `final turn: eval_count ${reply.evalCount ?? "?"}, thinking ${reply.hadThinking ? "non-empty" : "empty"}, ` +
          `done_reason ${reply.doneReason ?? "?"}, content ${reply.content.length} chars`
      );
      // Thinking can eat the whole answer budget, or the answer can land in the thinking field; or the JSON
      // answer is cut off at the cap. Retry once without thinking.
      const empty = !reply.content.trim();
      const cutOff = !empty && reply.doneReason === "length" && !extractJson(reply.content, (v) => v && typeof v === "object");
      if ((empty || cutOff) && !reply.toolCalls.length && opts.provider.canDropThinking) {
        const t1 = Date.now();
        try {
          reply = await ask(undefined, true, true);
        } finally {
          stats.modelMs += Date.now() - t1;
        }
        stats.evalTokens += reply.evalCount || 0;
        stats.finalRetry = empty ? "empty" : "cut-off";
        opts.onLog?.(
          `${finalRetryNote(stats.finalRetry)}: eval_count ${reply.evalCount ?? "?"}, thinking ${reply.hadThinking ? "non-empty" : "empty"}, ` +
            `done_reason ${reply.doneReason ?? "?"}, content ${reply.content.length} chars`
        );
      }
    }

    // A long answer cut off by the exploration-turn token cap: redo it as the final turn.
    if (!finalTurn && !reply.toolCalls.length && reply.truncated) {
      forceFinal = true;
      opts.onLog?.(`turn ${turn}: answer hit the exploration token cap, redoing as final turn`);
      continue;
    }

    const calls = finalTurn ? [] : reply.toolCalls;
    opts.onLog?.(
      `turn ${turn}${finalTurn ? " (final)" : ""}: ${calls.length} tool call(s), prompt ${messageChars(messages)} chars, ` +
        `${secs(Date.now() - t0)}s, ${reply.evalCount ?? "?"} tokens generated`
    );
    if (!calls.length) {
      // The answer (a natural one or the forced final) still isn't the task's JSON, often a correct answer in prose:
      // one turn that only re-emits it as JSON. A fresh one-message conversation, not the history; thinking off; a
      // cap sized to the answer. It may only restructure: a file path or evidence quote that isn't in the raw answer
      // gets the whole reformat rejected. If it fails or is rejected, the raw answer stands and the caller reports it
      // as unstructured. An empty answer has nothing to reformat.
      let reformatDetail: ReformatDetail | undefined;
      if (opts.answer && reply.content.trim() && !extractJson(reply.content, opts.answer.isValid)) {
        const raw = reply.content;
        const t2 = Date.now();
        try {
          const re = await opts.provider.chat(
            [{ role: "user", content: reformatPrompt(opts.answer.schema, raw) }],
            undefined, opts.signal, true, true, reformatNumPredict(raw),
          );
          stats.evalTokens += re.evalCount || 0;
          const parsed = extractJson(re.content, opts.answer.isValid);
          const introduced = parsed ? introducedBy(parsed, raw) : null;
          stats.reformat = !parsed ? "failed" : introduced ? "rejected" : "ok";
          reformatDetail = { raw, reply: re.content, ...(introduced ? { introduced } : {}) };
          opts.onLog?.(
            `${reformatNote(stats.reformat)}${introduced ? `: introduced ${introduced}` : ""}: eval_count ${re.evalCount ?? "?"}, ` +
              `done_reason ${re.doneReason ?? "?"}, content ${re.content.length} chars`
          );
          if (stats.reformat === "ok") reply = re;
        } catch (e: any) {
          stats.reformat = "failed";
          reformatDetail = { raw, reply: "" };
          opts.onLog?.(`${reformatNote(stats.reformat)}: ${e?.message || e}`);
        } finally {
          stats.modelMs += Date.now() - t2;
        }
      }
      return {
        text: reply.content, turns: turn, toolCalls: stats.toolCalls, filesRead: [...filesRead], partial,
        finalRetry: stats.finalRetry, malformedRetries: stats.malformedRetries, reformat: stats.reformat, reformatDetail,
      };
    }

    // Old reasoning isn't sent back; it's the biggest context cost.
    messages.push({ role: "assistant", content: reply.content || "", toolCalls: calls });
    for (const call of calls) {
      stats.toolCalls++;
      let out: string;
      try {
        out = await runRepoTool(opts.ws, opts.budget, call, filesRead);
      } catch (e: any) {
        out = `Error: ${e.message}`;
      }
      messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: out });
    }
    opts.onProgress?.(
      `turn ${turn}: ${stats.toolCalls} tool call(s), ${filesRead.size} file(s) read, budget ${Math.round(
        (100 * opts.budget.used) / opts.budget.limit
      )}%`
    );
  }
}
