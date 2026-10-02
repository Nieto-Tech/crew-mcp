// Unit tests for the reformat guard (introducedBy, hasContent). No server, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasContent, introducedBy } from "../dist/checks.js";

const RAW = "In src/pay.ts at line 38, `invoice.balance += amount;   // refund` refunds anything. Also see coverage in src/lib/util.ts.";
const finding = (o = {}) => ({ summary: "s", findings: [{ severity: "high", file: "src/pay.ts", line: 38, claim: "a reworded claim is fine", evidence: "invoice.balance += amount; // refund", suggestion: "new words are fine", ...o }] });

test("introducedBy: restructuring the answer's own paths and quotes introduces nothing", () => {
  assert.equal(introducedBy(finding(), RAW), null, "whitespace-insensitive evidence");
  assert.equal(introducedBy(finding({ file: "pay.ts" }), RAW), null, "a shorter form of a path that is there");
  assert.equal(introducedBy(finding({ file: "src/pay.ts:38" }), RAW), null, "a :line suffix is ignored");
  assert.equal(introducedBy({ summary: "x", files: [{ path: "src/pay.ts" }], coverage: [{ files: ["src/lib/util.ts"] }], risks: [] }, RAW), null);
  assert.equal(introducedBy({ summary: "only prose fields", findings: [] }, RAW), null);
});

test("introducedBy: a path or quote the raw answer never had is returned", () => {
  assert.equal(introducedBy(finding({ file: "src/billing/mint_service.js" }), RAW), "src/billing/mint_service.js");
  assert.equal(introducedBy(finding({ file: "backend/src/pay.ts" }), RAW), "backend/src/pay.ts", "a longer path is a guess");
  assert.equal(introducedBy(finding({ evidence: "db.query(x)" }), RAW), '"db.query(x)"');
  assert.equal(introducedBy({ summary: "x", files: [{ path: "src/pay.ts" }], coverage: [{ files: ["src/ghost.ts"] }] }, RAW), "src/ghost.ts", "nested files arrays");
  assert.equal(introducedBy({ summary: "x", risks: [{ file: "src/pay.ts", evidence: "y".repeat(200) }] }, RAW), `"${"y".repeat(77)}..."`, "long quotes are truncated in the note");
});

test("introducedBy: a near-JSON raw answer's escaped quotes still match", () => {
  const raw = '{"summary": "s", "findings": [{"file": "src/a.ts", "evidence": "const x = \\"a\\";\\nreturn x;"}],}';
  assert.equal(introducedBy({ findings: [{ file: "src/a.ts", evidence: 'const x = "a"; return x;' }] }, raw), null);
});

test("hasContent: an all-empty skeleton says nothing; any non-blank string at any depth does", () => {
  assert.equal(hasContent({ summary: "", files: [], functions: [], coverage: [], risks: [], openQuestions: [] }), false);
  assert.equal(hasContent({ summary: "  ", findings: [{ file: "", line: 0, claim: "" }] }), false, "whitespace and numbers don't count");
  assert.equal(hasContent({ summary: "", findings: [] , x: null }), false);
  assert.equal(hasContent({ summary: "No issues found.", findings: [] }), true, "a clean review with a summary is an answer");
  assert.equal(hasContent({ summary: "", files: [{ path: "src/pay.ts", why: "" }] }), true);
  assert.equal(hasContent({ summary: "", functions: ["chargeInvoice"] }), true);
});
