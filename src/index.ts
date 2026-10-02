#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { z } from "zod";
import { budgetsFor, loadConfig, userConfigPath } from "./config.js";
import { checkWorker, resolveRole, runTask, type TaskResult } from "./workers.js";
import { queueLine } from "./lane.js";
import { Workspace } from "./workspace.js";
import { checkCitations, extractJson, verifyFindings, type Finding } from "./checks.js";
import { RECON_SCHEMA, REVIEW_SCHEMA, SYSTEM, codeMapBlock, reconPrompt, reviewPrompt, secondOpinionPrompt } from "./prompts.js";
import { log } from "./log.js";
import { describePolicy, isLocalWorker, loadPolicy, POLICY_FILE } from "./policy.js";
import { diffStats, tooLargeMessage } from "./sizegate.js";
import { MALFORMED_NOTE, finalRetryNote, reformatNote } from "./agent.js";
import { loadCodeMap, mapNote, mapStatus } from "./codemap.js";
import { CREW_INSTRUCTIONS } from "./instructions.js";
import { formatStats, readUsage, recordReformat, recordUsage, todayLine, type Outcome, type Period } from "./usage.js";

export const VERSION = "0.3.0";

// Usage guidance travels with the server, so no CLAUDE.md snippet is needed.
const server = new McpServer({ name: "crew", version: VERSION }, { instructions: CREW_INSTRUCTIONS });

/* ---------- helpers ---------- */

type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };

function progressFor(extra: Extra) {
  const token = extra?._meta?.progressToken;
  let n = 0;
  return (message: string) => {
    log(message);
    if (token === undefined) return;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } }).catch(() => {});
  };
}

async function openWorkspace(dir?: string) {
  return Workspace.open(dir || process.env.CREW_WORKSPACE || process.cwd());
}

// What counts as each tool's structured answer: used to parse it, and to decide whether it needs a reformat turn.
const isRecon = (v: any) => v && typeof v === "object" && typeof v.summary === "string";
const isReview = (v: any) => v && Array.isArray(v.findings);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: any) => ({ content: [{ type: "text" as const, text: `crew error: ${e?.message || e}` }], isError: true });

function via(r: TaskResult) {
  const bits = [`${r.label}${r.model ? ` (${r.model})` : ""}`, `${(r.ms / 1000).toFixed(1)}s`];
  if (r.turns != null) bits.push(`${r.turns} turn${r.turns === 1 ? "" : "s"}`);
  if (r.toolCalls != null) bits.push(`${r.toolCalls} tool calls`);
  if (r.filesRead.length) bits.push(`${r.filesRead.length} files read`);
  if (r.evalTokens) bits.push(`${r.evalTokens.toLocaleString("en-US")} tokens`);
  if (r.queuedMs >= 100) bits.push(`queued ${(r.queuedMs / 1000).toFixed(1)}s`);
  let line = `_via ${bits.join(" · ")}_`;
  if (r.finalRetry) line += `\n_${finalRetryNote(r.finalRetry)}${r.finalRetry === "empty" ? " (the first final turn came back empty)" : ""}_`;
  if (r.malformedRetries) line += `\n_${MALFORMED_NOTE}${r.malformedRetries > 1 ? ` ×${r.malformedRetries}` : ""}_`;
  if (r.reformat) {
    const why =
      r.reformat === "ok" ? "the final answer wasn't valid JSON; one extra turn re-emitted it as JSON"
      : r.reformat === "rejected" ? `introduced ${r.reformatDetail?.introduced ?? "something not in the answer"}; the original answer is shown instead`
      : "the final answer wasn't valid JSON, and one extra turn to re-emit it didn't fix that";
    line += `\n_${reformatNote(r.reformat)}: ${why}_`;
  }
  if (r.skipped.length) line += `\n_fell back past: ${r.skipped.join("; ")}_`;
  if (r.partial) line += `\n_partial: ${r.partial}${r.diag ? ` (${r.diag})` : ""}. The scout answered with what it had; treat it as less complete._`;
  return line;
}

/** Log a finished call. `outcome` is decided by the tool once it has parsed the answer. */
function logCall(r: TaskResult, tool: string, ws: Workspace, outcome: Outcome, found?: { quoteChecked: number; unverified: number }) {
  const ts = new Date().toISOString();
  if (r.reformat && r.reformatDetail) {
    recordReformat({
      ts, tool, worker: r.worker, model: r.model, workspace: path.basename(ws.root), outcome: r.reformat,
      ...(r.reformatDetail.introduced ? { introduced: r.reformatDetail.introduced } : {}),
      raw: r.reformatDetail.raw, reformatted: r.reformatDetail.reply,
    });
  }
  recordUsage({
    ts,
    tool,
    worker: r.worker,
    provider: r.provider,
    model: r.model,
    local: r.local,
    workspace: path.basename(ws.root),
    wallSeconds: Math.round(r.ms) / 1000,
    turns: r.turns,
    toolCalls: r.toolCalls,
    filesRead: r.filesRead.length,
    charsRead: r.charsRead,
    tokens: r.evalTokens,
    outcome,
    ...found,
    ...(r.reformat ? { reformat: r.reformat } : {}),
  });
}

const workspaceArg = z
  .string()
  .optional()
  .describe("Absolute path of the repository. Defaults to the directory Claude Code launched the server in.");

/* ---------- crew_status ---------- */

server.registerTool(
  "crew_status",
  {
    title: "Crew status",
    description: "Show crew configuration, the workspace it will read, and which workers (local GPU, ChatGPT, API) are available. Run this first if another crew tool errors.",
    inputSchema: { workspace: workspaceArg },
    annotations: { readOnlyHint: true },
  },
  async ({ workspace }) => {
    try {
      const { config, sources } = loadConfig();
      const ws = await openWorkspace(workspace);
      const policy = loadPolicy(ws.root);
      const lines = [
        `# crew ${VERSION}`,
        `Workspace: ${ws.root}${(await ws.isGitRepo()) ? " (git)" : " (not a git repo: crew_review_diff unavailable)"}`,
        `Config: ${sources.join(" → ")}`,
        `Personal config file: ${userConfigPath()}`,
        "Usage guidance: sent to Claude as MCP server instructions on connect.",
        todayLine(readUsage()),
        `Repo policy: ${describePolicy(policy)}`,
        `Code map: ${mapStatus(await loadCodeMap(ws, policy))}`,
        "",
        "## Workers",
      ];
      const excluded: string[] = [];
      for (const [name, w] of Object.entries(config.workers)) {
        if (!policy.cloud && !isLocalWorker(w)) {
          excluded.push(name);
          lines.push(`- 🚫 **${name}** (${w.provider}): excluded by repo policy (cloud worker)`);
          continue;
        }
        const a = await checkWorker(name, w);
        const b = budgetsFor(w);
        lines.push(
          `- ${a.ok ? "✅" : "❌"} **${name}** (${w.provider}): ${a.detail}` +
            (w.provider !== "codex-cli" ? ` · read budget ${Math.round(b.readBudget / 1000)}K chars, ${b.maxTurns} turns` : "") +
            (w.provider !== "codex-cli" && isLocalWorker(w) ? queueLine(w, name) : "")
        );
      }
      if (excluded.length) lines.push("", `Policy excluded: ${excluded.join(", ")}. Nothing is sent to them and they are never a fallback.`);
      lines.push("", "## Roles");
      for (const role of ["scout", "reviewer"] as const) {
        try {
          const r = await resolveRole(config, role, policy);
          lines.push(`- **${role}** → ${r.name}${r.skipped.length ? ` (skipping ${r.skipped.length} unavailable)` : ""} · chain: ${config.roles[role].join(" → ")}`);
        } catch {
          lines.push(`- **${role}** → ❌ nothing available${policy.cloud ? "" : " (local only, per repo policy)"} · chain: ${config.roles[role].join(" → ")}`);
        }
      }
      return text(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

/* ---------- crew_recon ---------- */

interface Recon {
  summary: string;
  files?: { path: string; why?: string }[];
  functions?: string[];
  coverage?: { area: string; files?: string[]; status?: string; notes?: string }[];
  risks?: Finding[];
  openQuestions?: string[];
}

server.registerTool(
  "crew_recon",
  {
    title: "Crew recon",
    description:
      "Send a scout (local GPU first, ChatGPT as fallback) to map the code relevant to a question: files, functions, coverage of each stage, and evidence-backed risks. Use it before reading lots of files yourself, to save your context. Results are leads to confirm, not proof.",
    inputSchema: {
      question: z.string().describe("What to map, e.g. 'how does invoice payment flow from Stripe webhook to QBO?'"),
      paths: z.array(z.string()).optional().describe("Optional starting paths (hints)"),
      workspace: workspaceArg,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ question, paths, workspace }, extra) => {
    try {
      const { config } = loadConfig();
      const ws = await openWorkspace(workspace);
      const map = await loadCodeMap(ws, loadPolicy(ws.root));
      const r = await runTask({
        config,
        role: "scout",
        tool: "crew_recon",
        ws,
        system: SYSTEM(ws.root),
        prompt: reconPrompt(question, paths || [], codeMapBlock(map?.file || "", map?.text || "")),
        answer: { schema: RECON_SCHEMA, isValid: isRecon },
        onProgress: progressFor(extra as Extra),
      });

      const recon = extractJson<Recon>(r.text, isRecon);
      if (!recon) {
        logCall(r, "crew_recon", ws, "unstructured");
        return text(`${via(r)}\n\nScout did not return structured output. Raw answer:\n\n${r.text}`);
      }

      // Drop file references that don't exist; check risk evidence mechanically.
      const all = new Set(await ws.listFiles());
      const files = (recon.files || []).filter((f) => all.has(f.path));
      const missing = (recon.files || []).filter((f) => !all.has(f.path)).map((f) => f.path);
      const risks = await verifyFindings(ws, recon.risks || []);
      logCall(r, "crew_recon", ws, r.partial ? "partial" : "ok", { quoteChecked: risks.filter((k) => k.verified).length, unverified: risks.filter((k) => !k.verified).length });

      const out = [
        via(r),
        ...(mapNote(map) ? [mapNote(map)] : []),
        "",
        "## Summary",
        recon.summary,
        "",
        "## Files",
        ...files.map((f) => `- \`${f.path}\`${f.why ? `: ${f.why}` : ""}`),
      ];
      if (missing.length) out.push(`- _(dropped ${missing.length} nonexistent path(s): ${missing.join(", ")})_`);
      if (recon.functions?.length) out.push("", "## Functions", recon.functions.map((f) => `\`${f}\``).join(", "));
      if (recon.coverage?.length) {
        out.push("", "## Coverage");
        for (const c of recon.coverage) out.push(`- [${c.status || "?"}] ${c.area}${c.files?.length ? `: ${c.files.join(", ")}` : ""}${c.notes ? ` (${c.notes})` : ""}`);
      }
      if (risks.length) {
        out.push("", "## Risks");
        for (const k of risks) {
          out.push(
            `- ${k.verified ? "✅ quote found in code" : "⚠️ unverified"}: ${k.claim}` +
              `${k.resolvedFile ? ` (\`${k.resolvedFile}${k.line ? `:${k.line}` : ""}\`)` : ""} _(${k.why})_`
          );
        }
        out.push("_✅ means the quoted code exists where claimed, not that the claim is right._");
      }
      if (recon.openQuestions?.length) out.push("", "## Open questions", ...recon.openQuestions.map((q) => `- ${q}`));
      out.push("", "_Scout findings are leads. Confirm load-bearing claims in the code before relying on them._");
      return text(out.join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

/* ---------- crew_review_diff ---------- */

server.registerTool(
  "crew_review_diff",
  {
    title: "Crew diff review",
    description:
      "Have a scout review the current working-tree changes (staged, unstaged and new files) for bugs, security, concurrency and data-integrity problems. Findings are split into evidence-checked (the quoted code really exists) and unverified. Run it after making changes and before saying you're done.",
    inputSchema: {
      base: z.string().optional().describe("Git ref to diff against (default HEAD). Use e.g. 'main' for a whole branch."),
      paths: z.array(z.string()).optional().describe("Limit the review to these paths"),
      focus: z.string().optional().describe("What to look at hardest, e.g. 'transaction boundaries'"),
      includeUntracked: z
        .boolean()
        .optional()
        .describe("Include new untracked files (default true). AI-tool folders like .codex/ and .claude/ are always skipped."),
      force: z
        .boolean()
        .optional()
        .describe("Review even if the diff is too large for the scout (it is truncated, and may time out). Default false."),
      workspace: workspaceArg,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ base, paths, focus, includeUntracked, force, workspace }, extra) => {
    try {
      const { config } = loadConfig();
      const ws = await openWorkspace(workspace);
      const { diff, files, skippedUntracked } = await ws.diff(base || "HEAD", paths || [], { includeUntracked });
      if (!diff.trim()) return text(`No changes vs ${base || "HEAD"}${paths?.length ? ` in ${paths.join(", ")}` : ""}.`);

      // Keep the diff inside the scout's budget, leaving room to read context.
      const { name: scoutName, w } = await resolveRole(config, "scout", loadPolicy(ws.root));
      const maxDiff = Math.min(120_000, Math.round(budgetsFor(w).readBudget * 0.6));
      if (diff.length > maxDiff && !force) {
        // Too big to review well: say so now instead of burning the scout's whole timeout.
        return text(tooLargeMessage({ chars: diff.length, limit: maxDiff, worker: scoutName, stats: diffStats(diff), base: base || "HEAD" }));
      }
      const clipped = diff.length > maxDiff ? diff.slice(0, maxDiff) : diff;
      const note = diff.length > maxDiff ? `\n[DIFF TRUNCATED at ${maxDiff} chars of ${diff.length}. Changed files: ${files.join(", ")}]\n` : "";

      const map = await loadCodeMap(ws, loadPolicy(ws.root));
      const r = await runTask({
        config,
        role: "scout",
        tool: "crew_review_diff",
        ws,
        system: SYSTEM(ws.root),
        prompt: reviewPrompt(clipped, focus || "", note, codeMapBlock(map?.file || "", map?.text || "")),
        answer: { schema: REVIEW_SCHEMA, isValid: isReview },
        onProgress: progressFor(extra as Extra),
      });

      const parsed = extractJson<{ summary?: string; findings?: Finding[] }>(r.text, isReview);
      if (!parsed) {
        logCall(r, "crew_review_diff", ws, "unstructured");
        return text(`${via(r)}\n\nScout did not return structured output. Raw answer:\n\n${r.text}`);
      }

      const checked = await verifyFindings(ws, parsed.findings || [], diff);
      const verified = checked.filter((f) => f.verified);
      const unverified = checked.filter((f) => !f.verified);
      logCall(r, "crew_review_diff", ws, r.partial ? "partial" : "ok", { quoteChecked: verified.length, unverified: unverified.length });
      const sev = (f: Finding) => (f.severity || "?").toUpperCase();
      const fmt = (f: (typeof checked)[number]) =>
        `- **[${sev(f)}${f.category ? `/${f.category}` : ""}]** \`${f.resolvedFile || f.file || "?"}${f.line ? `:${f.line}` : ""}\`: ${f.claim}` +
        (f.evidence ? `\n  > ${f.evidence.split("\n")[0].slice(0, 200)}` : "") +
        (f.suggestion ? `\n  Fix: ${f.suggestion}` : "") +
        `\n  _(${f.why})_`;

      const out = [
        via(r),
        ...(mapNote(map) ? [mapNote(map)] : []),
        "",
        `Reviewed ${files.length} changed file(s) vs ${base || "HEAD"}${note ? " (diff truncated)" : ""}` +
          `${skippedUntracked.length ? `; skipped ${skippedUntracked.length} untracked (${skippedUntracked.slice(0, 4).join(", ")}${skippedUntracked.length > 4 ? ", …" : ""})` : ""}.`,
        parsed.summary ? `\n${parsed.summary}` : "",
        "",
        `## Quote-checked findings (${verified.length})`,
        "_The quoted code exists where claimed. That doesn't prove the claim; weigh the reasoning._",
        ...(verified.length ? verified.map(fmt) : ["None."]),
      ];
      if (unverified.length) {
        out.push("", `## Unverified (${unverified.length}): the quoted code wasn't found, treat as hints`, ...unverified.map(fmt));
      }
      return text(out.join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

/* ---------- crew_second_opinion ---------- */

server.registerTool(
  "crew_second_opinion",
  {
    title: "Crew second opinion",
    description:
      "Ask an independent reviewer (ChatGPT by default) to critique a plan, a design, or the current diff. Use it for risky work: payments, auth, migrations, concurrency. Expect disagreement; weigh it, don't just accept it.",
    inputSchema: {
      subject: z.string().describe("The plan, design or question to review. Include your reasoning."),
      includeDiff: z.boolean().optional().describe("Attach the current working-tree diff"),
      base: z.string().optional().describe("Git ref for the diff (default HEAD)"),
      files: z.array(z.string()).optional().describe("Files the reviewer should look at"),
      workspace: workspaceArg,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ subject, includeDiff, base, files, workspace }, extra) => {
    try {
      const { config } = loadConfig();
      const ws = await openWorkspace(workspace);
      const policy = loadPolicy(ws.root);
      if (!policy.cloud && !config.roles.reviewer.some((n) => isLocalWorker(config.workers[n]))) {
        return text(
          `crew_second_opinion is disabled by repo policy (${POLICY_FILE}): cloud workers are not allowed here and no local reviewer is configured.` +
            `${policy.source === "malformed" ? ` (${POLICY_FILE} is unreadable, so crew is failing closed: ${policy.problem})` : ""} Nothing was sent anywhere.`
        );
      }
      let diff = "";
      if (includeDiff) {
        const d = await ws.diff(base || "HEAD", [], { includeUntracked: true });
        diff = d.diff.length > 150_000 ? d.diff.slice(0, 150_000) + "\n[TRUNCATED]" : d.diff;
      }
      const r = await runTask({
        config,
        role: "reviewer",
        tool: "crew_second_opinion",
        ws,
        system: SYSTEM(ws.root),
        prompt: secondOpinionPrompt(subject, diff, files || []),
        onProgress: progressFor(extra as Extra),
      });
      logCall(r, "crew_second_opinion", ws, r.partial ? "partial" : "ok");
      const cites = await checkCitations(ws, r.text);
      const bad = cites.results.filter((c) => !c.ok);
      const footer = cites.total
        ? `\n\n_Citation check: ${cites.total - bad.length}/${cites.total} file:line references valid${
            bad.length ? `; invalid: ${bad.slice(0, 5).map((c) => `${c.citation} (${c.reason})`).join(", ")}` : ""
          }_`
        : "";
      return text(`${via(r)}\n\n${r.text}${footer}`);
    } catch (e) {
      return fail(e);
    }
  }
);

/* ---------- crew_check_citations ---------- */

server.registerTool(
  "crew_check_citations",
  {
    title: "Crew citation check",
    description:
      "Deterministically check file:line references in a piece of text against the repository: the file exists, the lines exist, and a backticked identifier on the same line really appears near those lines. No model involved. Use it on your own analysis before presenting it.",
    inputSchema: {
      text: z.string().describe("Text containing references like `server.ts:120-180`"),
      workspace: workspaceArg,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ text: body, workspace }) => {
    try {
      const ws = await openWorkspace(workspace);
      const { total, results } = await checkCitations(ws, body);
      if (!total) return text("No file:line citations found.");
      const bad = results.filter((c) => !c.ok);
      const out = [`${total - bad.length}/${total} citations valid.`];
      for (const c of results) {
        out.push(`${c.ok ? "✓" : "✗"} ${c.citation}${c.ok ? (c.note ? ` (${c.note} → ${c.resolvedFile})` : "") : ` — ${c.reason}`}`);
      }
      return text(out.join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

/* ---------- crew_stats ---------- */

server.registerTool(
  "crew_stats",
  {
    title: "Crew usage stats",
    description:
      "Show what the crew did: per worker, calls, time, files and characters read, tokens generated, and findings quote-checked vs unverified. ChatGPT calls show calls and time only. Includes a clearly labeled ESTIMATE of context kept out of Claude. Read from a local metadata-only log (no prompts or code).",
    inputSchema: { period: z.enum(["today", "week", "all"]).optional().describe("Default today") },
    annotations: { readOnlyHint: true },
  },
  async ({ period }) => {
    try {
      return text(formatStats(readUsage(), (period || "today") as Period));
    } catch (e) {
      return fail(e);
    }
  }
);

/* ---------- start ---------- */

const transport = new StdioServerTransport();
await server.connect(transport);
log(`crew ${VERSION} ready (cwd ${process.cwd()})`);
