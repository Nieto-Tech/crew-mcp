// Unit tests for the usage log, aggregation and the wording of the estimate.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aggregate, estimateKeptTokens, fmtDuration, formatStats, inPeriod, readUsage, recordUsage, todayLine } from "../dist/usage.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-usage-"));
const entry = (o = {}) => ({
  ts: "2026-10-01T12:00:00.000Z", tool: "crew_recon", worker: "local", provider: "ollama", model: "m", local: true,
  workspace: "repo", wallSeconds: 10, turns: 3, toolCalls: 2, filesRead: 4, charsRead: 8000, tokens: 500, outcome: "ok", ...o,
});
const NOW = new Date("2026-10-01T18:00:00.000Z");

test("log round-trips entries and creates the directory", () => {
  const file = path.join(dir, "nested", "usage.jsonl");
  recordUsage(entry(), file);
  recordUsage(entry({ worker: "chatgpt" }), file);
  const rows = readUsage(file);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].worker, "chatgpt");
});

test("reading skips a torn line and a missing file is empty", () => {
  const file = path.join(dir, "torn.jsonl");
  fs.writeFileSync(file, JSON.stringify(entry()) + "\n{\"ts\":\"2026-10-01T1\n\nnot json\n" + JSON.stringify(entry()) + "\n");
  assert.equal(readUsage(file).length, 2);
  assert.deepEqual(readUsage(path.join(dir, "nope.jsonl")), []);
});

test("recording never throws, even when the log can't be written", () => {
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x"); // a file where a directory is needed
  assert.doesNotThrow(() => recordUsage(entry(), path.join(blocker, "usage.jsonl")));
});

test("the entry holds metadata only", () => {
  const file = path.join(dir, "meta.jsonl");
  recordUsage(entry(), file);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).sort(), Object.keys(entry()).sort());
});

test("periods: today is since local midnight, week is 7 days, all is everything", () => {
  const rows = [
    entry({ ts: new Date(2026, 9, 1, 0, 30).toISOString() }), // today, just after local midnight
    entry({ ts: new Date(2026, 8, 30, 23, 30).toISOString() }), // yesterday
    entry({ ts: new Date(2026, 8, 26, 12).toISOString() }), // 5 days ago
    entry({ ts: new Date(2026, 8, 1, 12).toISOString() }), // a month ago
  ];
  const now = new Date(2026, 9, 1, 18);
  assert.equal(inPeriod(rows, "today", now).length, 1);
  assert.equal(inPeriod(rows, "week", now).length, 3);
  assert.equal(inPeriod(rows, "all", now).length, 4);
});

test("aggregate sums per worker and counts failures", () => {
  const t = aggregate([
    entry({ quoteChecked: 2, unverified: 1 }),
    entry({ filesRead: 6, charsRead: 12000, tokens: 700, wallSeconds: 20, quoteChecked: 1, unverified: 0 }),
    entry({ outcome: "timeout", wallSeconds: 5 }),
    entry({ worker: "chatgpt", provider: "codex-cli", local: false, filesRead: 0, charsRead: 0, tokens: undefined }),
  ]);
  const local = t.find((x) => x.worker === "local");
  assert.deepEqual(
    [local.calls, local.failed, local.seconds, local.filesRead, local.charsRead, local.tokens, local.quoteChecked, local.unverified],
    [3, 1, 35, 14, 28000, 1700, 3, 1]
  );
  assert.equal(t.find((x) => x.worker === "chatgpt").calls, 1);
});

test("estimate is local characters ÷ 4 and ignores cloud workers", () => {
  const t = aggregate([entry({ charsRead: 8000 }), entry({ charsRead: 4000 }), entry({ worker: "chatgpt", local: false, charsRead: 99999 })]);
  assert.equal(estimateKeptTokens(t), 3000);
});

test("stats output labels the estimate and shows ChatGPT as calls and time only", () => {
  const file = [entry({ quoteChecked: 1, unverified: 2 }), entry({ worker: "chatgpt", provider: "codex-cli", model: undefined, local: false, wallSeconds: 45, filesRead: 0, charsRead: 0, tokens: undefined })]
    .map((e) => ({ ...e, ts: new Date().toISOString() }));
  const out = formatStats(file, "today");
  assert.match(out, /# crew usage, today/);
  assert.match(out, /\*\*local\*\* \(ollama, m, local\): 1 call\(s\) · 10\.0s · 4 files read · 8,000 chars read · 500 tokens generated · findings: 1 quote-checked, 2 unverified/);
  assert.match(out, /\*\*chatgpt\*\* \(codex-cli, cloud\): 1 call\(s\) · 45\.0s \(calls and time only/);
  assert.doesNotMatch(out.split("\n").find((l) => l.includes("chatgpt")), /chars read|tokens generated/);
  assert.match(out, /ESTIMATE: context kept out of Claude ≈ 2,000 tokens \(characters read by local workers ÷ 4\)\. This is a rough estimate, not a measurement/);
});

test("empty period says so, without an estimate", () => {
  const out = formatStats([], "week");
  assert.match(out, /No crew calls recorded in this period/);
  assert.doesNotMatch(out, /ESTIMATE/);
});

test("status line summarizes today only", () => {
  const rows = [
    entry({ ts: NOW.toISOString(), wallSeconds: 70, charsRead: 8000 }),
    entry({ ts: NOW.toISOString(), worker: "chatgpt", local: false, wallSeconds: 45, charsRead: 0 }),
    entry({ ts: "2026-09-01T12:00:00.000Z" }),
  ];
  assert.equal(todayLine(rows, NOW), "today: 2 call(s) · local 1 (1m10s) · cloud 1 (45.0s) · ≈2,000 tokens kept out of Claude (estimate)");
  assert.equal(todayLine([], NOW), "today: no crew calls yet");
});

test("durations", () => {
  assert.equal(fmtDuration(9.04), "9.0s");
  assert.equal(fmtDuration(192), "3m12s");
  assert.equal(fmtDuration(119.7), "2m00s");
});
