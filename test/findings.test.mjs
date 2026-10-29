// Unit tests for the quote gate's line rewrite and the severity triage. A temp workspace, no server, no model.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bySeverity, isCommentOnly, locateQuote, triageFindings, verifyFindings } from "../dist/checks.js";
import { Workspace } from "../dist/workspace.js";

let ws;
const write = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};

// src/job.ts: a distinctive line at 30, a generic line at 10 and 40, a comment at 20.
const JOB = Array.from({ length: 50 }, (_, i) => `// filler ${i + 1}`);
JOB[9] = "  return rows;";
JOB[19] = "// runs inside one transaction";
JOB[29] = "  const windowEnd = await resolveWindowEnd(db, now);";
JOB[39] = "  return rows;";

before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-findings-"));
  write(root, "backend/src/job.ts", JOB.join("\n") + "\n");
  write(root, "backend/package.json", JSON.stringify({ name: "b", scripts: { build: "tsc", test: 'echo "Error: no test specified" && exit 1' } }));
  write(root, "web/src/view.ts", "export const v = 1;\n");
  write(root, "web/package.json", JSON.stringify({ name: "w", scripts: { "test:unit": "vitest" } }));
  write(root, "py/app.py", "x = 1\n");
  ws = await Workspace.open(root);
});

const f = (o) => ({ severity: "medium", category: "bug", file: "backend/src/job.ts", claim: "c", ...o });

test("locateQuote: maps a whitespace-normalized match back to the lines it spans", () => {
  const lines = ["a();", "", "  const x =", "    compute(y);", "b();", "const x = compute(y);"];
  assert.deepEqual(locateQuote(lines, "const x = compute(y);"), [{ start: 3, end: 4 }, { start: 6, end: 6 }]);
  assert.deepEqual(locateQuote(lines, "nothing here"), []);
});

test("verifyFindings: a quote found elsewhere in the file moves the finding's line there", async () => {
  const [far] = await verifyFindings(ws, [f({ line: 51, evidence: "const windowEnd = await resolveWindowEnd(db, now);" })]);
  assert.equal(far.verified, true);
  assert.equal(far.line, 30, "headline line is where the quote is");
  assert.equal(far.why, "quote found at line 30, not the cited line 51");

  const [near] = await verifyFindings(ws, [f({ line: 34, evidence: "const windowEnd = await resolveWindowEnd(db, now);" })]);
  assert.equal(near.line, 30);
  assert.equal(near.why, "quote found at line 30, near the cited line 34");

  const [exact] = await verifyFindings(ws, [f({ line: 30, evidence: "const windowEnd = await resolveWindowEnd(db, now);" })]);
  assert.equal(exact.why, "quote found at cited line");

  const [noLine] = await verifyFindings(ws, [f({ evidence: "const windowEnd = await resolveWindowEnd(db, now);" })]);
  assert.equal(noLine.line, 30);
  assert.equal(noLine.why, "quote found once in file (line 30)");
});

test("verifyFindings: a repeated quote takes the occurrence nearest the cited line, and still fails far from both", async () => {
  const [a] = await verifyFindings(ws, [f({ line: 37, evidence: "return rows;" })]);
  assert.equal(a.verified, true);
  assert.equal(a.line, 40);
  const [b] = await verifyFindings(ws, [f({ line: 25, evidence: "return rows;" })]);
  assert.equal(b.verified, false, "a generic quote nowhere near the cited line proves nothing");
  assert.equal(b.line, 25, "a failed finding keeps the cited line");
  assert.match(b.why, /appears 2× in file, none near the cited line/);
});

test("verifyFindings: a quote that only starts inside the window does not pass on the window", async () => {
  // Lines 29-31 hold the quote's text; cited line 21 puts 29 inside the window (13-29) but 31 outside it.
  const quote = "// filler 29 const windowEnd = await resolveWindowEnd(db, now); // filler 31";
  const [r] = await verifyFindings(ws, [f({ line: 21, evidence: quote })]);
  assert.equal(r.why, "quote found at line 29, not the cited line 21", "falls through to the unique-and-distinctive rule");
});

test("isCommentOnly: every non-blank line must be a comment", () => {
  assert.equal(isCommentOnly("// runs inside one transaction"), true);
  assert.equal(isCommentOnly("/**\n * header\n */"), true);
  assert.equal(isCommentOnly("# python comment\n\n-- sql comment"), true);
  assert.equal(isCommentOnly("// lock first\nawait lock();"), false);
  assert.equal(isCommentOnly("x = a * b"), false);
  assert.equal(isCommentOnly("12 | // old note\n13 |   // more"), true, "line-number prefixes are ignored");
  assert.equal(isCommentOnly("12 | doIt();"), false);
  assert.equal(isCommentOnly("   "), false);
});

test("triageFindings: a comment-only quote is capped at low; quote-checked status is untouched", async () => {
  const checked = await verifyFindings(ws, [f({ severity: "high", line: 20, evidence: "// runs inside one transaction" })]);
  const [t] = await triageFindings(ws, checked);
  assert.equal(t.verified, true);
  assert.equal(t.severity, "low");
  assert.match(t.why, /^quote found at cited line; capped at low: the quote is only a comment$/);
});

test("triageFindings: a tests finding is capped where no package.json above it has a real test script", async () => {
  const base = { verified: true, why: "w", category: "tests", severity: "medium", claim: "no tests" };
  const [noRunner, runner, notJs, other] = await triageFindings(ws, [
    { ...base, resolvedFile: "backend/src/job.ts" },
    { ...base, resolvedFile: "web/src/view.ts" },
    { ...base, resolvedFile: "py/app.py" },
    { ...base, category: "bug", resolvedFile: "backend/src/job.ts" },
  ]);
  assert.equal(noRunner.severity, "low");
  assert.equal(noRunner.why, "w; capped at low: no test script in backend/package.json");
  assert.equal(runner.severity, "medium", "test:unit counts as a runner");
  assert.equal(notJs.severity, "medium", "no package.json: not judged");
  assert.equal(other.severity, "medium", "only the tests category");
});

test("bySeverity: most severe first, ties keep their order, unknown last", () => {
  const out = bySeverity([{ severity: "low", claim: "a" }, { claim: "b" }, { severity: "HIGH", claim: "c" }, { severity: "low", claim: "d" }, { severity: "critical", claim: "e" }]);
  assert.deepEqual(out.map((x) => x.claim), ["e", "c", "a", "d", "b"]);
});

test("listFiles outside git uses forward slashes on every platform", async () => {
  const files = await ws.listFiles();
  assert.ok(files.includes("backend/src/job.ts"), files.join(", "));
  assert.ok(!files.some((f) => f.includes("\\")), files.join(", "));
});
