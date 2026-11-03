#!/usr/bin/env node
// Stand-in for the Codex CLI: honors --version and `exec ... -o <file> -`.
import fs from "node:fs";
const args = process.argv.slice(2);
if (process.env.CODEX_CALLS) fs.appendFileSync(process.env.CODEX_CALLS, args.join(" ") + "\n");
if (args.includes("--version")) { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
const out = args[args.indexOf("-o") + 1];
// Model names script the fake for panel tests: "slow-<ms>" answers after a delay, "fail" exits non-zero.
// CODEX_TIMES, when set, gets "start|end <model> <epoch ms>" lines so a test can see calls overlap.
const model = args.includes("-m") ? args[args.indexOf("-m") + 1] : "";
const mark = (what) => process.env.CODEX_TIMES && fs.appendFileSync(process.env.CODEX_TIMES, `${what} ${model} ${Date.now()}\n`);
mark("start");
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  if (model === "fail") { console.error("fake codex: scripted failure"); process.exit(1); }
  const slow = /^slow-(\d+)$/.exec(model);
  if (slow) await new Promise((r) => setTimeout(r, Number(slow[1])));
  if (!args.includes("read-only")) { console.error("expected read-only sandbox"); process.exit(3); }
  let answer;
  if (prompt.includes("INDEPENDENT second opinion")) {
    answer = "## Verdict\nagree with changes: the charge path is missing a lock.\n\n## Problems\n1. `chargeInvoice` updates the balance without a row lock (src/pay.ts:3-6).\n2. Bogus reference to src/pay.ts:400.\n\n## What I would change\nLock the invoice row first.";
  } else if (prompt.includes("Reconnaissance request")) {
    answer = JSON.stringify({ summary: "codex recon: charge flow lives in src/pay.ts", files: [{ path: "src/pay.ts", why: "charge logic" }], functions: ["chargeInvoice"], coverage: [], risks: [], openQuestions: [] });
  } else {
    answer = "unexpected prompt";
  }
  if (model) answer = answer.replace("## Verdict", `## Verdict (${model})`);
  fs.writeFileSync(out, answer);
  mark("end");
  console.log("codex done");
});
