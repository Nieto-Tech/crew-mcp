// Unit tests for the benchmark engine's scoring, on canned crew output and synthetic task definitions.
// No server, no model, and nothing from a real repo: task-specific cases live with their task files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorTest, cannedFinding, cannedRecon, cannedReview, checkCase, formatTable, median, summarize, parseOllamaPs, parseRecon, parseReview, parseVia, scoreRecon, scoreReviewTask } from "../bench/score.mjs";

const VIA = "_via Local GPU (Ollama) (qwen3.8:27b) · 41.2s · 7 turns · 6 tool calls · 3 files read · 5,120 tokens_";
const HOOK = "src/shop/webhook.ts";

// A synthetic review task, shaped like a task file entry.
const dedupe = {
  id: "review", kind: "review", anchor: HOOK, about: "duplicates/redelivery",
  match: (w) => /duplicate|re-?deliver/i.exec(w)?.[0] ?? null,
  nearMiss: { test: (w) => /\bguard\b/i.test(w), reason: "names the guard, not what it prevented" },
};
const dup = (file = `${HOOK}:12`) => ({ file, claim: "a redelivered event now throws instead of being acknowledged", evidence: "if (isDuplicate(err)) {", fix: "restore the duplicate check" });
const nit = (file, claim = "naming nit") => ({ severity: "LOW", file, claim, evidence: "const x = 1;" });

/* ---------- review scoring ---------- */

test("review: a quote-checked finding in the anchor file whose words match passes, with the matched text", () => {
  const s = scoreReviewTask(dedupe, cannedReview({ checked: [dup()] }));
  assert.equal(s.pass, true);
  assert.deepEqual([s.quoteChecked, s.unverified], [1, 0]);
  assert.match(s.reason, /matched "redeliver" in src\/shop\/webhook\.ts/);
  assert.equal(s.finding, dup().claim);
});

test("review: only the claim and fix count, never the quoted code", () => {
  assert.equal(scoreReviewTask(dedupe, cannedReview({ checked: [{ file: HOOK, claim: "looks different", evidence: "// a duplicate redelivery", fix: "" }] })).pass, false);
  assert.equal(scoreReviewTask(dedupe, cannedReview({ checked: [{ file: HOOK, claim: "looks different", fix: "handle the duplicate" }] })).pass, true, "the fix line is the model's words");
});

test("review: the right finding only under Unverified fails, and says so", () => {
  const s = scoreReviewTask(dedupe, cannedReview({ checked: [nit(HOOK)], unverified: [dup()] }));
  assert.equal(s.pass, false);
  assert.deepEqual([s.quoteChecked, s.unverified], [1, 1]);
  assert.match(s.reason, /only in Unverified/);
});

test("review: a near miss gets its own reason; otherwise the reason names the anchor and the bar", () => {
  assert.match(scoreReviewTask(dedupe, cannedReview({ checked: [{ file: HOOK, claim: "the guard was removed" }] })).reason, /^names the guard, not what it prevented$/);
  assert.match(scoreReviewTask(dedupe, cannedReview({ checked: [nit(HOOK)] })).reason, /^no quote-checked finding in webhook\.ts about duplicates\/redelivery$/);
  assert.match(scoreReviewTask({ ...dedupe, nearMiss: undefined }, cannedReview({ checked: [{ file: HOOK, claim: "the guard was removed" }] })).reason, /no quote-checked finding in webhook\.ts/);
  assert.equal(scoreReviewTask(dedupe, cannedReview({})).reason, "no quote-checked findings");
});

test("review: the anchor matches by file name; another file does not count", () => {
  assert.equal(scoreReviewTask(dedupe, cannedReview({ checked: [dup("webhook.ts:12")] })).pass, true, "bare file name");
  assert.equal(scoreReviewTask(dedupe, cannedReview({ checked: [dup("shop/webhook.ts")] })).pass, true, "shortened path");
  assert.equal(scoreReviewTask(dedupe, cannedReview({ checked: [dup("notwebhook.ts:12")] })).pass, false);
  assert.equal(scoreReviewTask(dedupe, cannedReview({ checked: [dup("src/shop/stock.ts:3")] })).pass, false);
  assert.equal(scoreReviewTask({ ...dedupe, anchor: /(^|\/)shop\/[a-z]+\.ts$/ }, cannedReview({ checked: [dup("src/shop/stock.ts:3")] })).pass, true, "a RegExp anchor");
});

test("anchorTest: file-name match, regex metacharacters in the name are literal", () => {
  const t = anchorTest("a/b/file.v2(x).ts");
  assert.equal(t("file.v2(x).ts"), true);
  assert.equal(t("q/file.v2(x).ts"), true);
  assert.equal(t("filexv2(x)xts"), false);
  assert.equal(t("myfile.v2(x).ts"), false);
});

test("review: unstructured, crew error and no-diff answers fail with a reason", () => {
  assert.match(scoreReviewTask(dedupe, `${VIA}\n\nScout did not return structured output. Raw answer:\n\nblah`).reason, /no structured output/);
  assert.match(scoreReviewTask(dedupe, "crew error: Worker timed out").reason, /timed out/);
  assert.match(scoreReviewTask(dedupe, "No changes vs HEAD.").reason, /no diff/);
  assert.equal(scoreReviewTask(dedupe, "").pass, false);
});

test("review: parse counts both sections and keeps the claim and fix as the finding's words", () => {
  const p = parseReview(cannedReview({ checked: [dup(), dup()], unverified: [dup()] }));
  assert.deepEqual([p.quoteChecked.length, p.unverified.length], [2, 1]);
  assert.equal(p.quoteChecked[0].file, HOOK, "the :line suffix is dropped");
  assert.equal(p.quoteChecked[0].words, `${dup().claim} ${dup().fix}`);
});

test("cannedFinding/cannedReview: the shape crew_review_diff prints", () => {
  assert.equal(
    cannedFinding({ severity: "MED", category: "concurrency", file: "a.ts:3", claim: "c", evidence: "q", fix: "f" }),
    "- **[MED/concurrency]** `a.ts:3`: c\n  > q\n  Fix: f\n  _(quote found in diff (changed or removed line))_",
  );
  const r = cannedReview({ checked: ["- **[LOW/bug]** `x.ts`: pre-rendered"] }).split("\n");
  assert.ok(r[0].startsWith("_via "));
  assert.ok(r.includes("## Quote-checked findings (1)"));
  assert.ok(cannedReview({}).includes("None."));
});

/* ---------- canned cases (what --check runs) ---------- */

test("checkCase: holds when pass and reason agree; says what differs when they don't", () => {
  assert.equal(checkCase(dedupe, { checked: [dup()], pass: true, reason: /redeliver/ }), null);
  assert.equal(checkCase(dedupe, { output: "crew error: x", pass: false }), null);
  assert.match(checkCase(dedupe, { checked: [nit(HOOK)], pass: true }), /^expected pass, got fail \(no quote-checked finding/);
  assert.match(checkCase(dedupe, { checked: [dup()], pass: true, reason: /duplicate/ }), /reason "matched "redeliver".*doesn't match \/duplicate\//);
  const recon = { kind: "recon", expect: [{ name: "webhook.ts", test: (p) => p.endsWith("webhook.ts") }] };
  assert.equal(checkCase(recon, { files: [HOOK], pass: true }), null);
  assert.match(checkCase(recon, { files: ["x.ts"], pass: true }), /expected pass, got fail \(missing: webhook\.ts\)/);
});

/* ---------- recon scoring ---------- */

const EXPECT = [
  { name: "webhook.ts", test: (p) => /(^|\/)webhook\.ts$/.test(p) },
  { name: "totals.ts", test: (p) => /(^|\/)totals\.ts$/.test(p) },
  { name: "migration adding the unique index", test: (p) => /migrations\/[^/]*_payments\.sql$/.test(p) },
];
const MIG = "db/migrations/001_payments.sql";
const recon = (files, opts) => cannedRecon(files, opts);

test("recon: all expected files is a full score and a pass", () => {
  const s = scoreRecon(recon([HOOK, "src/shop/totals.ts", MIG]), EXPECT);
  assert.deepEqual([s.pass, s.score, s.found, s.expected], [true, 1, 3, 3]);
});

test("recon: two of three is 2/3 and a fail naming the gap", () => {
  const s = scoreRecon(recon([HOOK, "src/shop/totals.ts"]), EXPECT);
  assert.equal(s.pass, false);
  assert.ok(Math.abs(s.score - 2 / 3) < 1e-9);
  assert.match(s.reason, /missing: migration adding the unique index/);
});

test("recon: dropped-path notes and unrelated files are ignored", () => {
  const p = parseRecon([VIA, "", "## Files", "_- _(dropped 1 nonexistent path(s): src/ghost.ts)_", "- `src/other.ts`: why"].join("\n"));
  assert.deepEqual(p.files, ["src/other.ts"]);
  assert.equal(scoreRecon(recon(["src/other.ts"]), EXPECT).score, 0);
});

test("recon: risk counts, unstructured and error answers", () => {
  const risks = ["- ✅ quote found in code: a (`x.ts:1`) _(why)_", "- ⚠️ unverified: b _(why)_", "- ⚠️ unverified: c _(why)_"];
  const s = scoreRecon(recon([HOOK], { risks }), EXPECT);
  assert.deepEqual([s.quoteChecked, s.unverified], [1, 2]);
  assert.match(scoreRecon(`${VIA}\n\nScout did not return structured output. Raw answer:\n\nx`, EXPECT).reason, /no structured output/);
  assert.equal(scoreRecon("crew error: boom", EXPECT).pass, false);
});

/* ---------- the via line ---------- */

test("via: parses model, time, turns, tool calls, tokens", () => {
  const v = parseVia(`${VIA}\n\nrest`);
  assert.deepEqual(
    { model: v.model, seconds: v.seconds, turns: v.turns, toolCalls: v.toolCalls, filesRead: v.filesRead, tokens: v.tokens, label: v.label },
    { model: "qwen3.8:27b", seconds: 41.2, turns: 7, toolCalls: 6, filesRead: 3, tokens: 5120, label: "Local GPU (Ollama)" }
  );
  assert.equal(v.finalRetry, null);
});

test("via: singular turn, queue time, retry and partial notes, fallback", () => {
  const v = parseVia(
    "_via Local GPU (Ollama) (m) · 9.0s · 1 turn · 0 tool calls · queued 2.5s_\n_final answer was cut off; retried without thinking_\n" +
      "_fell back past: local: down_\n_partial: stopped exploring at 195s (time limit) (7 turns, 6 tool calls, 120s in model generation, 0.0s queued). The scout answered with what it had; treat it as less complete._"
  );
  assert.equal(v.turns, 1);
  assert.equal(v.queuedSeconds, 2.5);
  assert.equal(v.seconds, 9);
  assert.equal(v.finalRetry, "cut-off");
  assert.equal(v.fellBack, true);
  assert.equal(v.partial, "stopped exploring at 195s (time limit)");
  assert.equal(parseVia("_via X (m) · 1.0s_\n_final answer retried without thinking (the first final turn came back empty)_").finalRetry, "empty");
});

test("via: the reformat turn is read as ok or failed", () => {
  assert.equal(parseVia("_via X (m) · 1.0s_\n_reformatted: the final answer wasn't valid JSON; one extra turn re-emitted it as JSON_").reformat, "ok");
  assert.equal(parseVia("_via X (m) · 1.0s_\n_reformat failed: the final answer wasn't valid JSON, and one extra turn to re-emit it didn't fix that_\n\nScout did not return structured output.").reformat, "failed");
  assert.equal(parseVia("_via X (m) · 1.0s_\n_reformat rejected: introduced src/billing/mint_service.js; the original answer is shown instead_").reformat, "rejected");
  assert.equal(parseVia(VIA).reformat, null);
  assert.equal(parseVia(`${VIA}\n\n## Quote-checked findings (1)\n- **[LOW/x]** \`a.ts\`: says _reformatted: inline_`).reformat, null, "only crew's own line, at line start");
});

test("via: malformed tool call retries are counted", () => {
  assert.equal(parseVia("_via X (m) · 1.0s_\n_malformed tool call retried_").malformedRetries, 1);
  assert.equal(parseVia("_via X (m) · 1.0s_\n_malformed tool call retried ×2_").malformedRetries, 2);
  assert.equal(parseVia(VIA).malformedRetries, 0);
});

test("via: no via line gives nulls, not a crash", () => {
  assert.equal(parseVia("crew error: x").turns, null);
  assert.equal(parseVia(undefined).seconds, null);
});

/* ---------- ollama ps + table ---------- */

test("parseOllamaPs: size and GPU share, matches :latest, null when not loaded", () => {
  const ps = { models: [{ name: "qwen3.8:27b", model: "qwen3.8:27b", size: 24_000_000_000, size_vram: 18_000_000_000, context_length: 65536 }, { name: "tiny:latest", size: 1e9, size_vram: 1e9 }] };
  assert.deepEqual(parseOllamaPs(ps, "qwen3.8:27b"), { sizeGB: 24, gpuPct: 75, contextLength: 65536 });
  assert.equal(parseOllamaPs(ps, "tiny").gpuPct, 100);
  assert.equal(parseOllamaPs(ps, "missing"), null);
  assert.equal(parseOllamaPs({}, "x"), null);
});

test("median: odd, even, empty, and nulls ignored", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([null, 5, undefined]), 5);
});

const run = (o) => ({ pass: true, wallMs: 10_000, turns: 5, toolCalls: 4, tokens: 1000, quoteChecked: 1, unverified: 0, retries: { malformed: 0, final: null, explorationRedos: 0 }, ...o });

test("summarize: pass rate, medians, retry totals, errors count as fails", () => {
  const s = summarize([
    run({ wallMs: 30_000, turns: 9, retries: { malformed: 1, final: "empty", explorationRedos: 2 }, ollama: { sizeGB: 20, gpuPct: 100 } }),
    run({ pass: false, reason: "no quote-checked findings", wallMs: 10_000, quoteChecked: 0, unverified: 3, partial: "stopped exploring at 195s (time limit)" }),
    { pass: false, error: "timed out", reason: "timed out" },
  ]);
  assert.equal(s.n, 3);
  assert.equal(s.passes, 1);
  assert.ok(Math.abs(s.passRate - 1 / 3) < 1e-9);
  assert.equal(s.errors, 1);
  assert.equal(s.medianWallMs, 20_000, "the errored run has no wall time and is left out");
  assert.equal(s.medianTurns, 7);
  assert.deepEqual(s.retries, { finalRuns: 1, explorationRedos: 2, malformed: 1 });
  assert.equal(s.partialRuns, 1);
  assert.equal(s.ollama.gpuPct, 100);
  assert.deepEqual(s.failReasons, ["no quote-checked findings", "timed out"]);
  assert.equal(summarize([]).passRate, 0);
});

test("summarize: recon mean found and expected", () => {
  const s = summarize([run({ found: 3, expected: 3 }), run({ found: 2, expected: 3, pass: false })]);
  assert.equal(s.meanFound, 2.5);
  assert.equal(s.expected, 3);
});

test("formatTable: one row per model per task with pass rate and medians; errors and partials visible", () => {
  const doc = {
    taskNames: [["review", "planted bug"], ["recon", "recon"]],
    models: [
      { model: "a", baseline: true, tasks: {
          review: summarize([run({ ollama: { sizeGB: 24, gpuPct: 100 }, retries: { malformed: 1, final: "empty", explorationRedos: 1 }, quoteChecked: 2, unverified: 1 }), run({ wallMs: 30_000, quoteChecked: 2, unverified: 1 }), run({ wallMs: 50_000 })]),
          recon: summarize([run({ pass: false, found: 2, expected: 3, reason: "missing: x", partial: "stopped" }), run({ pass: false, found: 3, expected: 3, reason: "missing: y" })]) } },
      { model: "b", tasks: { review: summarize([{ pass: false, error: "boom", reason: "boom" }]) } },
      { model: "c", error: "could not load model: not found" },
    ],
  };
  const t = formatTable(doc).split("\n");
  assert.equal(t.length, 2 + 2 + 1 + 1);
  assert.match(t[2], /a \(baseline\) \| planted bug \| ✅ 3\/3 \| – \| 30\.0s \| 5 \| 4 \| 1,000 \| final×1, redo×1, malformed×1 \| – \| 2\/1 \| 24 GB \| 100%/);
  assert.match(t[3], /recon \| ❌ 0\/2 \| 2\.5\/3/);
  assert.match(t[3], /1 partial; missing: x/);
  assert.match(t[4], /^\| b \| planted bug \| 💥 0\/1/);
  assert.match(t[5], /^\| c \| – \| 💥/);
  assert.match(formatTable({ models: [{ model: "m", tasks: { review: summarize([run(), run({ pass: false, reason: "r" })]) } }] }), /⚠️ 1\/2/);
  // Rows follow the task file's order and names; a results file without names shows ids.
  const named = formatTable({ taskNames: [["b", "second"], ["a", "first"]], models: [{ model: "m", tasks: { a: summarize([run()]), b: summarize([run()]) } }] }).split("\n");
  assert.match(named[2], /^\| m \| second \|/);
  assert.match(named[3], /^\| m \| first \|/);
  assert.match(formatTable({ models: [{ model: "m", tasks: { review_hard: summarize([run()]) } }] }), /^\| m \| review_hard \| ✅ 1\/1/m);
});

test("formatTable: a Reformats column counts the runs that needed the reformat turn, and how many it didn't rescue", () => {
  const head = formatTable({ models: [] }).split("\n")[0].split(" | ");
  const col = head.indexOf("Reformats");
  assert.equal(head[col - 1], "Retries");
  const cell = (runs) => formatTable({ models: [{ model: "m", tasks: { review_hard: summarize(runs) } }] }).split("\n")[2].split(" | ")[col];
  assert.equal(cell([run({ reformat: "ok" }), run({ reformat: "ok" }), run()]), "2");
  assert.equal(cell([run({ reformat: "ok" }), run({ pass: false, reformat: "failed" }), run()]), "2 (1 failed)");
  assert.equal(cell([run({ reformat: "rejected" }), run({ pass: false, reformat: "failed" }), run({ reformat: "ok" })]), "3 (1 failed, 1 rejected)");
  assert.equal(cell([run(), run()]), "–");
  assert.equal(cell([{ pass: true }]), "–", "older results without the field");
  const s = summarize([run({ reformat: "ok" }), run({ reformat: "failed" }), run()]);
  assert.deepEqual(s.reformats, { runs: 2, failed: 1, rejected: 0 });
  // The error row keeps every column.
  const err = formatTable({ models: [{ model: "c", error: "boom" }] }).split("\n")[2].split(" | ");
  assert.equal(err.length, head.length);
});
