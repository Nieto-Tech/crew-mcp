// Pure helpers for the benchmark engine: parse crew tool output, score review and recon tasks as a task file
// defines them, render canned crew output for a task file's `cases`, read `ollama ps`, print the table.
// No I/O, so it is unit-tested on canned text. What to benchmark lives in a task file (see bench/README.md).

/* ---------- the `_via ..._` line ---------- */

/** Metrics from the `_via ..._` line crew puts at the top of every scout answer. */
export function parseVia(text) {
  const out = {
    label: null, model: null, seconds: null, turns: null, toolCalls: null, filesRead: null,
    tokens: null, queuedSeconds: 0, finalRetry: null, malformedRetries: 0, reformat: null, partial: null, fellBack: false,
  };
  const lines = String(text || "").split("\n");
  const line = lines.find((l) => l.startsWith("_via "));
  if (!line) return out;
  const parts = line.replace(/^_via /, "").replace(/_$/, "").split(" · ");
  const head = /^(.*?)(?: \(([^()]+)\))?$/.exec(parts[0]);
  out.label = head?.[1] ?? parts[0];
  out.model = head?.[2] ?? null;
  for (const p of parts.slice(1)) {
    let m;
    if ((m = /^queued ([\d.]+)s$/.exec(p))) out.queuedSeconds = Number(m[1]);
    else if ((m = /^([\d.]+)s$/.exec(p))) out.seconds = Number(m[1]);
    else if ((m = /^(\d+) turns?$/.exec(p))) out.turns = Number(m[1]);
    else if ((m = /^(\d+) tool calls?$/.exec(p))) out.toolCalls = Number(m[1]);
    else if ((m = /^(\d+) files read$/.exec(p))) out.filesRead = Number(m[1]);
    else if ((m = /^([\d,]+) tokens$/.exec(p))) out.tokens = Number(m[1].replace(/,/g, ""));
  }
  const all = lines.join("\n");
  if (/final answer was cut off; retried without thinking/.test(all)) out.finalRetry = "cut-off";
  else if (/final answer retried without thinking/.test(all)) out.finalRetry = "empty";
  const mal = /^_malformed tool call retried(?: ×(\d+))?_$/m.exec(all);
  if (mal) out.malformedRetries = Number(mal[1] || 1);
  // 0.1.10: one reformat turn when the answer wasn't the tool's JSON; "ok" if it produced it.
  // 0.1.11: "rejected" when it introduced a path or quote the raw answer didn't have.
  if (/^_reformatted: /m.test(all)) out.reformat = "ok";
  else out.reformat = /^_reformat (failed|rejected): /m.exec(all)?.[1] ?? null;
  out.partial = /^_partial: (.*?)(?: \(\d+ turns?,|\. The scout)/m.exec(all)?.[1] ?? null;
  out.fellBack = /^_fell back past:/m.test(all);
  return out;
}

export const isCrewError = (text) => /^crew error:/.test(String(text || ""));
export const isUnstructured = (text) => /Scout did not return structured output/.test(String(text || ""));

/* ---------- crew_review_diff ---------- */

const sectionOf = (text, header) => {
  const lines = String(text || "").split("\n");
  const i = lines.findIndex((l) => l.startsWith(header));
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith("## ")) j++;
  return { heading: lines[i], body: lines.slice(i + 1, j) };
};

/** Split a findings section into bullets: {file, claim, text (claim+fix, not the quote), raw}. */
function bullets(body) {
  const out = [];
  for (const l of body) {
    if (/^- \*\*\[/.test(l)) out.push([l]);
    else if (out.length && /^\s+/.test(l)) out[out.length - 1].push(l);
  }
  return out.map((ls) => {
    const head = /^- \*\*\[([^\]]*)\]\*\* `([^`]*)`: (.*)$/.exec(ls[0]);
    const file = head?.[2] ?? "";
    const claim = head?.[3] ?? ls[0];
    // The model's own words: the claim and the fix. The quote is code, and `_(why)_` is crew's text.
    const fix = ls.filter((l) => /^\s+Fix: /.test(l)).map((l) => l.replace(/^\s+Fix: /, "")).join(" ");
    return { severity: head?.[1] ?? "", file: file.replace(/:\d+$/, ""), claim, words: `${claim} ${fix}`, raw: ls.join("\n") };
  });
}

export function parseReview(text) {
  const checked = sectionOf(text, "## Quote-checked findings");
  const unver = sectionOf(text, "## Unverified");
  return {
    quoteChecked: checked ? bullets(checked.body) : [],
    unverified: unver ? bullets(unver.body) : [],
    unstructured: isUnstructured(text),
  };
}

/** A review task's anchor as a test on a finding's file: a RegExp as given, or a path matched by file name (so a
 * shortened path such as `src/x/file.ts` or a bare `file.ts` still counts, but `notfile.ts` doesn't). */
export function anchorTest(anchor) {
  if (anchor instanceof RegExp) return (f) => anchor.test(f);
  const base = String(anchor).split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|/)${base}$`);
  return (f) => re.test(f);
}

/**
 * Score a crew_review_diff answer for one review task. Pass = a quote-checked finding in the task's `anchor` file
 * whose own words (claim or fix) satisfy `task.match` (words → matched text, or null). Words only inside the quoted
 * code do not count, nor does a finding the quote check could not confirm. `task.nearMiss` ({ test(words) → bool,
 * reason }) names findings that are on the bug but short of the bar, so the fail reason says so.
 */
export function scoreReviewTask(task, text) {
  const p = parseReview(text);
  const base = { quoteChecked: p.quoteChecked.length, unverified: p.unverified.length, unstructured: p.unstructured };
  if (isCrewError(text)) return { ...base, pass: false, reason: String(text).slice(0, 160) };
  if (p.unstructured) return { ...base, pass: false, reason: "no structured output" };
  if (/^No changes vs/.test(String(text))) return { ...base, pass: false, reason: "crew saw no diff" };
  const inAnchor = anchorTest(task.anchor);
  const where = task.anchor instanceof RegExp ? String(task.anchor) : String(task.anchor).split("/").pop();
  const inFile = (f) => inAnchor(f.file);
  const fits = (f) => inFile(f) && task.match(f.words) != null;
  const hit = p.quoteChecked.find(fits);
  if (hit) return { ...base, pass: true, reason: `matched "${task.match(hit.words)}" in ${hit.file}`, finding: hit.claim };
  const why = p.unverified.some(fits)
    ? "right finding, but only in Unverified (quote not found)"
    : task.nearMiss && p.quoteChecked.some((f) => inFile(f) && task.nearMiss.test(f.words))
      ? task.nearMiss.reason
      : p.quoteChecked.length
        ? `no quote-checked finding in ${where} about ${task.about}`
        : "no quote-checked findings";
  return { ...base, pass: false, reason: why };
}

/* ---------- crew_recon ---------- */

export function parseRecon(text) {
  const t = String(text || "");
  const files = (sectionOf(t, "## Files")?.body ?? []).map((l) => /^- `([^`]+)`/.exec(l)?.[1]).filter(Boolean);
  return {
    files,
    risksChecked: (t.match(/^- ✅ quote found in code/gm) || []).length,
    risksUnverified: (t.match(/^- ⚠️ unverified/gm) || []).length,
    unstructured: isUnstructured(t),
  };
}

/** Score a crew_recon answer: pass = every `expected` file ({ name, test(path) → bool }) is in its Files section. */
export function scoreRecon(text, expected) {
  const p = parseRecon(text);
  const base = { quoteChecked: p.risksChecked, unverified: p.risksUnverified, unstructured: p.unstructured, files: p.files.length };
  if (isCrewError(text)) return { ...base, pass: false, score: 0, reason: String(text).slice(0, 160) };
  if (p.unstructured) return { ...base, pass: false, score: 0, reason: "no structured output" };
  const found = expected.filter((e) => p.files.some(e.test));
  const missing = expected.filter((e) => !found.includes(e)).map((e) => e.name);
  return {
    ...base,
    pass: missing.length === 0,
    score: found.length / expected.length,
    found: found.length,
    expected: expected.length,
    reason: missing.length ? `missing: ${missing.join("; ")}` : "all expected files found",
  };
}

/* ---------- canned crew output (task-file cases and tests) ---------- */

export const CANNED_VIA = "_via Local GPU (Ollama) (canned) · 41.2s · 7 turns · 6 tool calls · 3 files read · 5,120 tokens_";

/** One finding bullet as crew_review_diff prints it: `{ severity, category, file, claim, evidence, fix }`. */
export const cannedFinding = ({ severity = "HIGH", category = "bug", file, claim, evidence = "some quoted code line here", fix = "" }) =>
  `- **[${severity}/${category}]** \`${file}\`: ${claim}\n  > ${evidence}${fix ? `\n  Fix: ${fix}` : ""}\n  _(quote found in diff (changed or removed line))_`;

/** A crew_review_diff answer with these quote-checked and unverified findings (objects or pre-rendered bullets). */
export function cannedReview({ checked = [], unverified = [], via = CANNED_VIA } = {}) {
  const render = (f) => (typeof f === "string" ? f : cannedFinding(f));
  return [
    via, "", "Reviewed 1 changed file(s) vs HEAD.", "", "Summary line.", "",
    `## Quote-checked findings (${checked.length})`,
    "_The quoted code exists where claimed. That doesn't prove the claim; weigh the reasoning._",
    ...(checked.length ? checked.map(render) : ["None."]),
    ...(unverified.length ? ["", `## Unverified (${unverified.length}): the quoted code wasn't found, treat as hints`, ...unverified.map(render)] : []),
  ].join("\n");
}

/** A crew_recon answer whose Files section lists these paths. */
export const cannedRecon = (files, { risks = [], via = CANNED_VIA } = {}) =>
  [via, "", "## Summary", "map", "", "## Files", ...files.map((f) => `- \`${f}\`: x`), ...(risks.length ? ["", "## Risks", ...risks] : [])].join("\n");

/**
 * Score one canned case against its task: the case gives `output` (raw text), or `checked`/`unverified` findings
 * (review), or `files` (recon), plus the expected `pass` and optionally a `reason` RegExp. Returns null if it holds,
 * else what went wrong.
 */
export function checkCase(task, c) {
  const text = c.output ?? (task.kind === "recon" ? cannedRecon(c.files || [], { risks: c.risks, via: c.via }) : cannedReview({ checked: c.checked, unverified: c.unverified, via: c.via }));
  const got = task.kind === "recon" ? scoreRecon(text, task.expect) : scoreReviewTask(task, text);
  if (got.pass !== c.pass) return `expected ${c.pass ? "pass" : "fail"}, got ${got.pass ? "pass" : "fail"} (${got.reason})`;
  if (c.reason && !c.reason.test(got.reason)) return `reason "${got.reason}" doesn't match ${c.reason}`;
  return null;
}

/* ---------- ollama ps (/api/ps) ---------- */

/** Size and GPU share of a loaded model, from the JSON behind `ollama ps`. */
export function parseOllamaPs(json, model) {
  const m = (json?.models || []).find((x) => [x.name, x.model].some((n) => n === model || n === `${model}:latest`));
  if (!m) return null;
  return {
    sizeGB: Math.round((m.size / 1e9) * 10) / 10,
    gpuPct: m.size ? Math.round((100 * (m.size_vram ?? 0)) / m.size) : null,
    contextLength: m.context_length ?? null,
  };
}

/* ---------- several runs of one task ---------- */

export function median(xs) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

/** Pass rate, medians and retry totals over the runs of one model/task. A run that errored counts as a fail. */
export function summarize(runs) {
  const n = runs.length;
  const passes = runs.filter((r) => r.pass).length;
  return {
    n,
    passes,
    passRate: n ? passes / n : 0,
    errors: runs.filter((r) => r.error).length,
    medianWallMs: median(runs.map((r) => r.wallMs)),
    medianTurns: median(runs.map((r) => r.turns)),
    medianToolCalls: median(runs.map((r) => r.toolCalls)),
    medianTokens: median(runs.map((r) => r.tokens)),
    medianQuoteChecked: median(runs.map((r) => r.quoteChecked)),
    medianUnverified: median(runs.map((r) => r.unverified)),
    meanFound: mean(runs.map((r) => r.found)),
    expected: runs.find((r) => r.expected != null)?.expected ?? null,
    retries: {
      finalRuns: runs.filter((r) => r.retries?.final).length,
      explorationRedos: runs.reduce((a, r) => a + (r.retries?.explorationRedos || 0), 0),
      malformed: runs.reduce((a, r) => a + (r.retries?.malformed || 0), 0),
    },
    partialRuns: runs.filter((r) => r.partial).length,
    reformats: {
      runs: runs.filter((r) => r.reformat).length,
      failed: runs.filter((r) => r.reformat === "failed").length,
      rejected: runs.filter((r) => r.reformat === "rejected").length,
    },
    ollama: [...runs].reverse().find((r) => r.ollama)?.ollama ?? null,
    failReasons: [...new Set(runs.filter((r) => !r.pass).map((r) => r.reason).filter(Boolean))].slice(0, 2),
  };
}

/* ---------- report ---------- */

const fmtSecs = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)}s`);
const num = (x) => (x == null ? "–" : Number.isInteger(x) ? String(x) : x.toFixed(1));
const retriesOf = (t) => {
  const r = t.retries || {};
  const bits = [];
  if (r.finalRuns) bits.push(`final×${r.finalRuns}`);
  if (r.explorationRedos) bits.push(`redo×${r.explorationRedos}`);
  if (r.malformed) bits.push(`malformed×${r.malformed}`);
  return bits.join(", ") || "–";
};
// Runs that needed the reformat turn, and how many of those it didn't rescue.
const reformatsOf = (t) => {
  const r = t.reformats;
  if (!r?.runs) return "–";
  const bad = [r.failed && `${r.failed} failed`, r.rejected && `${r.rejected} rejected`].filter(Boolean);
  return bad.length ? `${r.runs} (${bad.join(", ")})` : String(r.runs);
};

/** One row per model per task, summarised over its runs, in the task file's order and with its task names. */
export function formatTable(doc) {
  const head = ["Model", "Task", "Pass", "Score", "Median wall", "Turns", "Tools", "Tokens", "Retries", "Reformats", "Checked/Unverified", "Size", "GPU", "Note"];
  const rows = [head, head.map(() => "---")];
  // [id, name] pairs from the run; a results file without them shows task ids.
  const taskNames = doc.taskNames?.length ? doc.taskNames : [...new Set(doc.models.flatMap((m) => Object.keys(m.tasks || {})))].map((id) => [id, id]);
  for (const m of doc.models) {
    if (m.error) {
      rows.push([m.model, "–", "💥", "–", "–", "–", "–", "–", "–", "–", "–", "–", "–", m.error.slice(0, 70)]);
      continue;
    }
    for (const [key, name] of taskNames) {
      const t = m.tasks?.[key];
      if (!t) continue;
      const mark = t.passes === t.n ? "✅" : t.passes === 0 ? (t.errors === t.n ? "💥" : "❌") : "⚠️";
      rows.push([
        m.model + (m.baseline ? " (baseline)" : ""),
        name,
        `${mark} ${t.passes}/${t.n}`,
        t.meanFound != null ? `${num(t.meanFound)}/${t.expected}` : "–",
        fmtSecs(t.medianWallMs),
        num(t.medianTurns),
        num(t.medianToolCalls),
        t.medianTokens != null ? Math.round(t.medianTokens).toLocaleString("en-US") : "–",
        retriesOf(t),
        reformatsOf(t),
        `${num(t.medianQuoteChecked ?? 0)}/${num(t.medianUnverified ?? 0)}`,
        t.ollama ? `${t.ollama.sizeGB} GB` : "–",
        t.ollama?.gpuPct != null ? `${t.ollama.gpuPct}%` : "–",
        ((t.partialRuns ? `${t.partialRuns} partial; ` : "") + (t.failReasons?.[0] || "")).slice(0, 70),
      ]);
    }
  }
  return rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
}
