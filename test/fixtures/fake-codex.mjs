#!/usr/bin/env node
// Stand-in for the Codex CLI: honors --version and `exec ... -o <file> -`.
import fs from "node:fs";
const args = process.argv.slice(2);
if (process.env.CODEX_CALLS) fs.appendFileSync(process.env.CODEX_CALLS, args.join(" ") + "\n");
if (args.includes("--version")) { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
const out = args[args.indexOf("-o") + 1];
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (!args.includes("read-only")) { console.error("expected read-only sandbox"); process.exit(3); }
  let answer;
  if (prompt.includes("INDEPENDENT second opinion")) {
    answer = "## Verdict\nagree with changes: the charge path is missing a lock.\n\n## Problems\n1. `chargeInvoice` updates the balance without a row lock (src/pay.ts:3-6).\n2. Bogus reference to src/pay.ts:400.\n\n## What I would change\nLock the invoice row first.";
  } else if (prompt.includes("Reconnaissance request")) {
    answer = JSON.stringify({ summary: "codex recon: charge flow lives in src/pay.ts", files: [{ path: "src/pay.ts", why: "charge logic" }], functions: ["chargeInvoice"], coverage: [], risks: [], openQuestions: [] });
  } else {
    answer = "unexpected prompt";
  }
  fs.writeFileSync(out, answer);
  console.log("codex done");
});
