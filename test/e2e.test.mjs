// End-to-end: spawn the built server over stdio with the real MCP client,
// against a fake Ollama and a fake codex binary.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Server children inherit this, so tests never write to the real ~/.local/state/crew.
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crew-state-"));
const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "index.js");
const fakeCodex = path.join(here, "fixtures", "fake-codex.mjs");

let ollama, port, repo, cfgFile, requests = [], leaks = 0, gateInflight = 0, gateMax = 0, gateOrder = [];
let malformedPlan = []; // plan-model: true = answer this request with a tool-call parse error
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Scripted local model: first turn uses a tool, second answers in JSON.
function ollamaReply(body) {
  const user = body.messages.find((m) => m.role === "user").content;
  const usedTool = body.messages.some((m) => m.role === "tool");
  if (user.includes("Reconnaissance request")) {
    if (!usedTool) return { role: "assistant", content: "", tool_calls: [{ function: { name: "search_code", arguments: { pattern: "chargeInvoice" } } }] };
    return { role: "assistant", content: "Here is the map:\n" + JSON.stringify({
      summary: "chargeInvoice in src/pay.ts updates the balance",
      files: [{ path: "src/pay.ts", why: "charge logic" }, { path: "src/ghost.ts", why: "made up" }],
      functions: ["chargeInvoice"],
      coverage: [{ area: "charging", files: ["src/pay.ts"], status: "found" }],
      risks: [
        { claim: "balance updated without a lock", file: "src/pay.ts", evidence: "invoice.balance -= amount;" },
        { claim: "invented risk", file: "src/pay.ts", evidence: "db.unsafeRawQuery(x)" },
      ],
      openQuestions: [],
    }) };
  }
  if (user.includes("Review this change")) {
    if (!usedTool) return { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "src/pay.ts" } } }] };
    return { role: "assistant", content: JSON.stringify({
      summary: "Refund path added; balance can go negative.",
      findings: [
        { severity: "high", category: "data-integrity", file: "pay.ts", line: 38, claim: "refund does not check the amount against what was paid", evidence: "invoice.balance += amount; // refund", suggestion: "cap refunds at amount paid" },
        { severity: "medium", category: "bug", file: "src/pay.ts", line: 20, claim: "generic quote far from the cited line", evidence: "return invoice;" },
        { severity: "critical", category: "security", file: "src/pay.ts", line: 2, claim: "hallucinated SQL injection", evidence: "db.query(`SELECT * FROM x WHERE id=${id}`)" },
      ],
    }) };
  }
  return { role: "assistant", content: "{}" };
}

// The prose answers the reformat turn is given, and the finding prose-model's JSON then carries.
const PROSE_RECON = "Charging lives in src/pay.ts: chargeInvoice subtracts the amount from invoice.balance and returns the invoice. No other files are involved.";
const PROSE_REVIEW = "One real problem: in src/pay.ts line 38, `invoice.balance += amount; // refund` refunds any amount without checking it against what was paid. Cap refunds at the amount paid.";
const LEAD_IN = "I have enough to answer. Final report:";
const PROSE_FINDING = { severity: "high", category: "data-integrity", file: "src/pay.ts", line: 38, claim: "refund does not check the amount against what was paid", evidence: "invoice.balance += amount; // refund", suggestion: "cap refunds at amount paid" };

before(async () => {
  ollama = http.createServer(async (req, res) => {
    if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "test-model:latest" }, { name: "slow-model:latest" }, { name: "drip-model:latest" }, { name: "gate-model:latest" }, { name: "redirect-model:latest" }, { name: "trunc-model:latest" }, { name: "emptythink-model:latest" }, { name: "alwaysempty-model:latest" }, { name: "cutoff-model:latest" }, { name: "malformed-model:latest" }, { name: "badtool-model:latest" }, { name: "crash-model:latest" }, { name: "tagcase-model:Q4_K_M" }, { name: "prose-model:latest" }, { name: "proseonly-model:latest" }, { name: "proseerr-model:latest" }, { name: "invent-model:latest" }, { name: "plan-model:latest" }, { name: "lead-model:latest" }, { name: "leadonly-model:latest" }] })); return; }
    let b = ""; for await (const c of req) b += c;
    if (req.url === "/leak") { leaks++; res.end("{}"); return; } // a redirected prompt would land here
    const body = JSON.parse(b);
    requests.push(body);
    if (body.model === "slow-model") return; // never answers: exercises the worker timeout
    const recon = (summary) => JSON.stringify({ summary, files: [], functions: [], coverage: [], risks: [], openQuestions: [] });
    const reply = (content, extra = {}) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ message: { role: "assistant", content, ...extra.message }, eval_count: 50, done_reason: "stop" })); };
    if (body.model === "redirect-model") { res.statusCode = 307; res.setHeader("location", `http://127.0.0.1:${port}/leak`); res.end(); return; }
    if (body.model === "trunc-model") { // a long answer that the exploration-turn cap cuts off
      if (body.tools) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ message: { role: "assistant", content: '{"summary": "cut o' }, done_reason: "length" })); return; }
      return reply(recon("complete answer after redo"));
    }
    if (body.model === "emptythink-model" || body.model === "alwaysempty-model") {
      // Wants one tool call, then on the answer turn: thinking on => empty content, thinking off => an answer.
      if (body.tools) return reply("", { message: { tool_calls: [{ function: { name: "list_files", arguments: {} } }] } });
      if (body.think === false && body.model === "emptythink-model") return reply(recon("answer after retry without thinking"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: { role: "assistant", content: "", thinking: "pondering…" }, eval_count: 8192, done_reason: "length" }));
      return;
    }
    if (body.model === "malformed-model" || body.model === "badtool-model" || body.model === "crash-model") {
      const used = body.messages.some((m) => m.role === "tool");
      const err = (msg) => { res.statusCode = 500; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: msg })); };
      const XML = "XML syntax error on line 7: element <parameter> closed by </function>";
      if (body.model === "crash-model") return err("model runner has unexpectedly stopped");
      if (body.model === "badtool-model") return err(XML);
      if (!used && !body.messages.some((m) => m.role === "user" && /malformed/.test(m.content))) return err(XML); // first try fails, the nudged retry works
      if (!used) return reply("", { message: { tool_calls: [{ function: { name: "list_files", arguments: {} } }] } });
      return reply(recon("answer after malformed retry"));
    }
    if (body.model === "cutoff-model") { // answer turn with thinking: JSON cut off at the cap; without thinking: complete
      if (body.tools) return reply("", { message: { tool_calls: [{ function: { name: "list_files", arguments: {} } }] } });
      if (body.think === false) return reply(recon("complete answer after cut-off retry"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: { role: "assistant", content: '{"summary": "cut o', thinking: "long reasoning" }, eval_count: 8192, done_reason: "length" }));
      return;
    }
    if (["prose-model", "proseonly-model", "proseerr-model", "invent-model"].includes(body.model)) {
      // Answers correctly, but in prose. On the reformat turn prose-model returns that content as JSON; proseonly-model doesn't.
      const first = body.messages.find((m) => m.role === "user").content;
      if (first.startsWith("Return only this content as JSON")) {
        if (body.model === "proseerr-model") { res.statusCode = 500; res.end(JSON.stringify({ error: "model runner has unexpectedly stopped" })); return; }
        if (body.model === "invent-model") { // valid JSON, but with a path (review) or a quote (recon) the prose never had
          if (first.includes('"findings"')) return reply(JSON.stringify({ summary: "s", findings: [{ ...PROSE_FINDING, file: "src/billing/mint_service.js", line: 142 }] }));
          return reply(JSON.stringify({ summary: "s", files: [{ path: "src/pay.ts", why: "x" }], functions: [], coverage: [], risks: [{ claim: "c", file: "src/pay.ts", line: 3, evidence: "invoice.balance = 0;" }], openQuestions: [] }));
        }
        if (body.model === "proseonly-model") return reply("Sure. As I said, chargeInvoice in src/pay.ts updates the balance.");
        if (first.includes('"findings"')) return reply(JSON.stringify({ summary: "reformatted review", findings: [PROSE_FINDING] }));
        return reply(JSON.stringify({ summary: "reformatted: chargeInvoice in src/pay.ts updates the balance", files: [{ path: "src/pay.ts", why: "charge logic" }], functions: ["chargeInvoice"], coverage: [], risks: [], openQuestions: [] }));
      }
      // One tool call, then the prose answer: prose-model gives it on its own (tools still offered), the others on the forced final turn.
      if (body.tools && !body.messages.some((m) => m.role === "tool")) return reply("", { message: { tool_calls: [{ function: { name: "list_files", arguments: {} } }] } });
      return reply(first.includes("Review this change") ? PROSE_REVIEW : PROSE_RECON);
    }
    if (body.model === "lead-model" || body.model === "leadonly-model") {
      // Stops exploring on its own with only a lead-in, whose reformat is an empty skeleton. On the forced final turn
      // lead-model writes the answer; leadonly-model writes the lead-in again.
      const first = body.messages.find((m) => m.role === "user").content;
      if (first.startsWith("Return only this content as JSON")) return reply(recon(""));
      if (body.tools && !body.messages.some((m) => m.role === "tool")) return reply("", { message: { tool_calls: [{ function: { name: "list_files", arguments: {} } }] } });
      if (!body.tools && body.model === "lead-model") return reply(recon("answer after the empty lead-in"));
      return reply(LEAD_IN);
    }
    if (body.model === "plan-model") {
      if (malformedPlan.shift()) { res.statusCode = 500; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "XML syntax error on line 7: element <parameter> closed by </function>" })); return; }
      if (!body.messages.some((m) => m.role === "tool")) return reply("", { message: { tool_calls: [{ function: { name: "list_files", arguments: {} } }] } });
      return reply(recon("answer after the planned malformed calls"));
    }
    if (body.model === "drip-model") { // slow on every turn, and always wants another tool call until tools are removed
      await sleep(400);
      if (body.tools) return reply("", { message: { tool_calls: [{ function: { name: "list_files", arguments: {} } }] } });
      return reply(recon("drip final answer"));
    }
    if (body.model === "gate-model") { // one at a time, please
      const user = body.messages.find((m) => m.role === "user").content;
      const isReview = user.includes("Review this change");
      gateOrder.push(isReview ? "review" : (user.match(/\bq-\w+/) || ["?"])[0]);
      gateMax = Math.max(gateMax, ++gateInflight);
      await sleep(600);
      gateInflight--;
      return reply(isReview ? JSON.stringify({ summary: "gate review", findings: [] }) : recon("gate answer"));
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: ollamaReply(body) }));
  });
  await new Promise((r) => ollama.listen(0, r));
  port = ollama.address().port;

  repo = fs.mkdtempSync(path.join(os.tmpdir(), "crew-repo-"));
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src/pay.ts"), "export function chargeInvoice(invoice, amount) {\n  // charge\n  invoice.balance -= amount;\n  return invoice;\n}\n");
  git("add", "."); git("commit", "-qm", "init");
  fs.appendFileSync(path.join(repo, "src/pay.ts"), "\n" + "// padding\n".repeat(30) + "export function refundInvoice(invoice, amount) {\n  invoice.balance += amount; // refund\n  return invoice;\n}\n");
  fs.writeFileSync(path.join(repo, "src/new.ts"), "export const added = true;\n");
  fs.mkdirSync(path.join(repo, ".codex"));
  fs.writeFileSync(path.join(repo, ".codex/config.toml"), "model = \"x\"\n");

  cfgFile = path.join(repo, "..", `crew-test-${port}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify({
    workers: {
      local: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "test-model", numCtx: 32768 },
      nope: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "not-pulled", numCtx: 8192 },
      tiny: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "test-model", readBudgetChars: 500 },
      slow: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "slow-model", timeoutMs: 1500 },
      two: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "test-model", maxTurns: 2 },
      thinky: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "test-model", maxTurns: 2, thinkOnTools: true, numPredictTools: 111, numPredictFinal: 222 },
      drip: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "drip-model", timeoutMs: 6000 },
      gate: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "gate-model", timeoutMs: 1000 },
      gateq: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "gate-model", timeoutMs: 1000, queueWaitMs: 200 },
      gateage: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "gate-model", timeoutMs: 1000, reconYieldMs: 100 },
      redirectq: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "redirect-model", queueWaitMs: 300 },
      emptythink: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "emptythink-model", maxTurns: 2 },
      emptythinkoff: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "emptythink-model", maxTurns: 2, thinkOnFinal: false },
      cutoff: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "cutoff-model", maxTurns: 2 },
      malformed: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "malformed-model", maxTurns: 4 },
      badtool: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "badtool-model", maxTurns: 4 },
      crash: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "crash-model", maxTurns: 4 },
      tagcase: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "tagcase-model:q4_k_m" },
      typo: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "test-mode" },
      alwaysempty: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "alwaysempty-model", maxTurns: 2 },
      prose: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "prose-model" },
      proseonly: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "proseonly-model", maxTurns: 2 },
      invent: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "invent-model" },
      plan: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "plan-model", maxTurns: 6 },
      lead: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "lead-model" },
      leadonly: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "leadonly-model" },
      proseerr: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "proseerr-model", maxTurns: 2 },
      trunc: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "trunc-model" },
      redirect: { provider: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "redirect-model" },
      chatgpt: { provider: "codex-cli", codexPath: fakeCodex },
    },
    roles: { scout: ["local", "chatgpt"], reviewer: ["chatgpt"] },
  }));
});

after(() => { ollama?.closeAllConnections(); ollama?.close(); });

// Every client is closed after its test, pass or fail, so a failure can't leave a server process hanging the suite.
const opened = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close().catch(() => {})));
});

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: { ...process.env, CREW_WORKSPACE: repo, CREW_CONFIG: cfgFile, XDG_CONFIG_HOME: path.join(repo, ".no-user-config"), ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  opened.push(client);
  await client.connect(transport);
  return client;
}
const call = async (client, name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

test("sends usage instructions on connect", async () => {
  const c = await connect();
  const instructions = c.getInstructions() || "";
  assert.match(instructions, /crew_review_diff/);
  assert.match(instructions, /quote-checked/i);
  assert.match(instructions, /don't retry or poll/);
  await c.close();
});

test("lists the crew tools", async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["crew_check_citations", "crew_recon", "crew_review_diff", "crew_second_opinion", "crew_stats", "crew_status"]);
  await c.close();
});

test("status shows workers and role resolution", async () => {
  const c = await connect();
  const out = await call(c, "crew_status", {});
  assert.match(out, /✅ \*\*local\*\*/);
  assert.match(out, /❌ \*\*nope\*\*.*not pulled/);
  assert.match(out, /\*\*scout\*\* → local/);
  assert.match(out, /\*\*reviewer\*\* → chatgpt/);
  await c.close();
});

test("recon drops nonexistent files and checks risk evidence", async () => {
  const c = await connect();
  const out = await call(c, "crew_recon", { question: "how does charging work?" });
  assert.match(out, /`src\/pay.ts`: charge logic/);
  assert.match(out, /dropped 1 nonexistent path\(s\): src\/ghost.ts/);
  assert.match(out, /✅ quote found in code: balance updated without a lock/);
  assert.match(out, /⚠️ unverified: invented risk/);
  // The task message must be present on every request to the model.
  assert.ok(requests.every((r) => r.messages.some((m) => m.role === "user")));
  await c.close();
});

test("diff review separates evidence-checked findings from hallucinations", async () => {
  const c = await connect();
  const out = await call(c, "crew_review_diff", {});
  assert.match(out, /Reviewed 2 changed file\(s\)/); // tracked change + untracked new file
  assert.match(out, /Quote-checked findings \(1\)/);
  assert.match(out, /refund does not check the amount[\s\S]*quote found at cited line/);
  assert.match(out, /Unverified \(2\)/);
  assert.match(out, /generic quote far from the cited line[\s\S]*appears 2× in file[\s\S]*too generic/);
  assert.match(out, /hallucinated SQL injection[\s\S]*quote not found in file or diff/);
  // AI-tool state in the working tree is not reviewed.
  assert.match(out, /skipped 1 untracked \(\.codex\/config\.toml\)/);
  await c.close();
});

test("scout falls back to ChatGPT when the local model is unavailable", async () => {
  const c = await connect({ CREW_SCOUT: "nope,chatgpt" });
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.match(out, /codex recon: charge flow/);
  assert.match(out, /fell back past: nope/);
  await c.close();
});

test("second opinion runs codex read-only and checks its citations", async () => {
  const c = await connect();
  const out = await call(c, "crew_second_opinion", { subject: "Is chargeInvoice safe?", includeDiff: true });
  assert.match(out, /## Verdict/);
  assert.match(out, /Citation check: 1\/2 file:line references valid/);
  assert.match(out, /src\/pay.ts:400 \(line range outside file/);
  await c.close();
});

test("on Windows, codex installed as a .cmd shim runs, found on PATH or by path, from a directory with a space", { skip: process.platform !== "win32" && "Windows only: spawn can't run a .cmd without cmd.exe" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew codex shim "));
  // An npm-generated shim (its script runs under Node directly) and a hand-written one (runs through cmd.exe).
  const script = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.mjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(fakeCodex, script);
  fs.writeFileSync(path.join(dir, "codex.cmd"), '@ECHO off\r\nSET "_prog=node"\r\nendLocal & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.mjs" %*\r\n'.replace("%dp0%", "%~dp0"));
  const wrapper = path.join(dir, "wrapped codex.cmd");
  fs.writeFileSync(wrapper, `@"${process.execPath}" "${fakeCodex}" %*\r\n`);
  const calls = path.join(dir, "calls.txt");
  const MODEL = 'gpt-5 & echo pwned %PATH% "q"';
  const cfg = (name, w) => {
    const f = path.join(dir, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify({ workers: { chatgpt: { provider: "codex-cli", ...w } }, roles: { scout: ["chatgpt"], reviewer: ["chatgpt"] } }));
    return f;
  };
  const cases = [
    ["npm shim on PATH, hostile model name", { CREW_CONFIG: cfg("npm", { model: MODEL }), PATH: `${dir};${process.env.PATH}`, CODEX_CALLS: calls }],
    // The cmd.exe fallback: an injection attempt in an argument must stay an argument.
    ["hand-written .cmd by path, injection attempt", { CREW_CONFIG: cfg("wrapper", { codexPath: wrapper, model: `x" & echo pwned > "${path.join(dir, "pwned.txt")}" & "` }) }],
  ];
  for (const [label, env] of cases) {
    const c = await connect(env);
    assert.match(await call(c, "crew_status", {}), /codex-cli 0\.0\.0-fake/, label);
    const out = await call(c, "crew_second_opinion", { subject: "Is chargeInvoice safe?" });
    assert.match(out, /## Verdict/, `${label}: ${out.slice(0, 300)}`);
    await c.close();
  }
  assert.ok(fs.readFileSync(calls, "utf8").includes(`-m ${MODEL}`), "the model name reached codex literally, nothing expanded or run");
  assert.ok(!fs.existsSync(path.join(dir, "pwned.txt")), "nothing in an argument ran as a command through cmd.exe");
});

test("citation check does not blame a paragraph's first identifier on every citation", async () => {
  const c = await connect();
  const out = await call(c, "crew_check_citations", {
    text: "`chargeInvoice` commits at `src/pay.ts:3`, but the refund path (`src/pay.ts:20`) and the new flag (`src/new.ts:1`) differ.",
  });
  assert.match(out, /3\/3 citations valid/);
  await c.close();
});

test("citation check is deterministic and catches wrong identifiers", async () => {
  const c = await connect();
  const out = await call(c, "crew_check_citations", {
    text: "`chargeInvoice` at `pay.ts:1-3`\n`refundInvoice` at `src/pay.ts:1-2`\n`nothing.ts:4`",
  });
  assert.match(out, /1\/3 citations valid/);
  assert.match(out, /✓ pay.ts:1-3/);
  assert.match(out, /✗ src\/pay.ts:1-2 — `refundInvoice` not found near lines 1-2/);
  assert.match(out, /✗ nothing.ts:4 — file not found/);
  await c.close();
});

/* ---------- v0.1.3: size gate ---------- */

test("size gate: a diff over the scout's budget returns fast without calling the model", async () => {
  const c = await connect({ CREW_SCOUT: "tiny" });
  const before = requests.length;
  const out = await call(c, "crew_review_diff", {});
  assert.match(out, /Diff too large to review well/);
  assert.match(out, /2 changed file\(s\)/);
  assert.match(out, /No model was called/);
  assert.match(out, /`src\/`: 2 file\(s\), \+\d+\/-0/); // grouped by directory with counts
  assert.match(out, /`pay.ts` \+\d+\/-0/);
  assert.match(out, /`paths`/);
  assert.match(out, /force: true/);
  assert.equal(requests.length, before);
  await c.close();
});

test("size gate: paths narrows a big diff back under the budget", async () => {
  const c = await connect({ CREW_SCOUT: "tiny" });
  const out = await call(c, "crew_review_diff", { paths: ["src/new.ts"] });
  assert.doesNotMatch(out, /too large/);
  assert.match(out, /Reviewed 1 changed file\(s\)/);
  await c.close();
});

test("size gate: force reviews anyway, truncated", async () => {
  const c = await connect({ CREW_SCOUT: "tiny" });
  const before = requests.length;
  const out = await call(c, "crew_review_diff", { force: true });
  assert.doesNotMatch(out, /too large/);
  assert.match(out, /diff truncated/);
  assert.ok(requests.length > before);
  await c.close();
});

/* ---------- v0.1.3: repo policy (.crew.json) ---------- */

function policyRepo(policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-policy-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/pay.ts"), "export function chargeInvoice(invoice, amount) {\n  invoice.balance -= amount;\n  return invoice;\n}\n");
  if (policy !== undefined) fs.writeFileSync(path.join(dir, ".crew.json"), policy);
  git("add", "."); git("commit", "-qm", "init");
  return dir;
}
const codexCalls = () => path.join(os.tmpdir(), `crew-codex-calls-${process.pid}-${Math.random().toString(36).slice(2)}`);

test("policy cloud:false with the local worker up runs locally", async () => {
  const dir = policyRepo('{ "cloud": false }');
  const calls = codexCalls();
  const c = await connect({ CODEX_CALLS: calls });
  const out = await call(c, "crew_recon", { question: "how does charging work?", workspace: dir });
  assert.match(out, /_via Local GPU/);
  assert.ok(!fs.existsSync(calls), "codex must not run");
  await c.close();
});

test("policy cloud:false with the local worker down fails and never calls codex", async () => {
  const dir = policyRepo('{ "cloud": false }');
  const calls = codexCalls();
  const c = await connect({ CREW_SCOUT: "nope,chatgpt", CODEX_CALLS: calls });
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging", workspace: dir } });
  assert.equal(r.isError, true);
  const out = r.content[0].text;
  assert.match(out, /No LOCAL worker available/);
  assert.match(out, /repo policy \(\.crew\.json cloud:false\)/);
  assert.match(out, /Not falling back/);
  assert.match(out, /excluded: chatgpt/);
  assert.doesNotMatch(out, /codex recon/);
  assert.ok(!fs.existsSync(calls), "codex must not run, not even --version");
  await c.close();
});

test("policy cloud:false with no local worker in the chain fails naming the policy", async () => {
  const dir = policyRepo('{ "cloud": false }');
  fs.appendFileSync(path.join(dir, "src/pay.ts"), "// changed\n");
  const c = await connect({ CREW_SCOUT: "chatgpt" });
  const r = await c.callTool({ name: "crew_review_diff", arguments: { workspace: dir } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /forbids cloud workers/);
  await c.close();
});

test("policy cloud:false disables second opinion without calling anything", async () => {
  const dir = policyRepo('{ "cloud": false }');
  const calls = codexCalls();
  const c = await connect({ CODEX_CALLS: calls });
  const out = await call(c, "crew_second_opinion", { subject: "is this safe?", workspace: dir });
  assert.match(out, /disabled by repo policy \(\.crew\.json\)/);
  assert.ok(!fs.existsSync(calls));
  await c.close();
});

test("policy cloud:false allows second opinion when a LOCAL reviewer is configured", async () => {
  const dir = policyRepo('{ "cloud": false }');
  const c = await connect({ CREW_REVIEWER: "local" });
  const out = await call(c, "crew_second_opinion", { subject: "is this safe?", workspace: dir });
  assert.doesNotMatch(out, /disabled by repo policy/);
  assert.match(out, /_via Local GPU/);
  await c.close();
});

test("policy malformed .crew.json fails closed and says so", async () => {
  const dir = policyRepo("{ not json");
  const calls = codexCalls();
  const c = await connect({ CREW_SCOUT: "nope,chatgpt", CODEX_CALLS: calls });
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging", workspace: dir } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /failing closed/);
  const so = await call(c, "crew_second_opinion", { subject: "x", workspace: dir });
  assert.match(so, /disabled by repo policy[\s\S]*failing closed/);
  assert.ok(!fs.existsSync(calls));
  await c.close();
  // a wrong type for "cloud" is also treated as unreadable
  const dir2 = policyRepo('{ "cloud": "false" }');
  const c2 = await connect();
  assert.match(await call(c2, "crew_status", { workspace: dir2 }), /FAILING CLOSED/);
  await c2.close();
});

test("status shows the policy and the workers it excluded", async () => {
  const dir = policyRepo('{ "cloud": false }');
  const c = await connect();
  const out = await call(c, "crew_status", { workspace: dir });
  assert.match(out, /Repo policy: .*cloud:false, local workers only/);
  assert.match(out, /🚫 \*\*chatgpt\*\*.*excluded by repo policy/);
  assert.match(out, /Policy excluded: chatgpt/);
  assert.match(out, /\*\*scout\*\* → local/);
  assert.match(out, /\*\*reviewer\*\* → ❌ nothing available \(local only/);
  await c.close();
});

test("no .crew.json (or cloud:true) leaves cloud workers available", async () => {
  const dir = policyRepo(undefined);
  const c = await connect({ CREW_SCOUT: "nope,chatgpt" });
  assert.match(await call(c, "crew_recon", { question: "map charging", workspace: dir }), /codex recon/);
  assert.match(await call(c, "crew_status", { workspace: dir }), /Repo policy: none/);
  await c.close();
  const dir2 = policyRepo('{ "cloud": true }');
  const c2 = await connect({ CREW_SCOUT: "nope,chatgpt" });
  assert.match(await call(c2, "crew_recon", { question: "map charging", workspace: dir2 }), /codex recon/);
  await c2.close();
});

test("a remote openai worker is cloud; a private-IP one is local", async () => {
  const dir = policyRepo('{ "cloud": false }');
  const cfg = path.join(os.tmpdir(), `crew-policy-cfg-${port}.json`);
  fs.writeFileSync(cfg, JSON.stringify({
    workers: {
      remote: { provider: "openai", model: "x", baseUrl: "https://api.openai.com/v1" },
      lan: { provider: "openai", model: "x", baseUrl: "http://192.168.1.20:8080/v1" },
      pubollama: { provider: "ollama", model: "x", baseUrl: "http://gpu.example.com:11434" },
    },
    roles: { scout: ["remote", "pubollama", "lan"], reviewer: ["remote"] },
  }));
  const c = await connect({ CREW_CONFIG: cfg });
  const out = await call(c, "crew_status", { workspace: dir });
  assert.match(out, /🚫 \*\*remote\*\*/);
  assert.match(out, /🚫 \*\*pubollama\*\*/);
  // Classified local (not 🚫); with nothing listening there it is reported unreachable rather than available.
  assert.match(out, /❌ \*\*lan\*\*.*server not reachable at http:\/\/192\.168\.1\.20/);
  assert.doesNotMatch(out, /🚫 \*\*lan\*\*/);
  await c.close();
});

/* ---------- v0.1.3: timeouts + guidance ---------- */

test("a worker timeout names the worker, the time, and the fix", async () => {
  const c = await connect({ CREW_SCOUT: "slow" });
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  assert.equal(r.isError, true);
  const out = r.content[0].text;
  assert.match(out, /Worker "slow".*timed out after 1\.5s/);
  assert.match(out, /narrow the request with `paths`/);
  assert.match(out, /raise timeoutMs for "slow" in .*config\.json/);
  assert.match(out, /\(\d+ turns?, 0 tool calls, 1\.\ds in model generation, 0\.0s queued\)/);
  await c.close();
});

test("instructions cover the size gate and repo policy", async () => {
  const c = await connect();
  const i = c.getInstructions() || "";
  assert.match(i, /normal-sized changes/);
  assert.match(i, /`paths`/);
  assert.match(i, /\.crew\.json policy .* enforced by crew itself/);
  await c.close();
});

test("instructions explain the shared queue and when to use a background subagent", async () => {
  const c = await connect();
  const i = (c.getInstructions() || "").replace(/\s+/g, " ");
  assert.match(i, /shared by every Claude session on this machine/);
  assert.match(i, /Calls sent in parallel don't finish sooner/);
  assert.match(i, /background subagent/);
  assert.match(i, /Call crew_review_diff directly/);
  await c.close();
});

/* ---------- v0.1.4: reliability ---------- */

test("exploration turns send think:false + num_predict 2048; the final turn allows thinking + 8192", async () => {
  const c = await connect({ CREW_SCOUT: "two" });
  const before = requests.length;
  await call(c, "crew_recon", { question: "how does charging work?" });
  const mine = requests.slice(before);
  assert.equal(mine.length, 2);
  assert.ok(mine[0].tools, "turn 1 has tools");
  assert.equal(mine[0].think, false);
  assert.equal(mine[0].options.num_predict, 2048);
  assert.equal(mine[1].tools, undefined, "final turn has no tools");
  assert.equal(mine[1].think, undefined);
  assert.equal(mine[1].options.num_predict, 8192);
  await c.close();
});

test("thinkOnTools / numPredictTools / numPredictFinal are configurable per worker", async () => {
  const c = await connect({ CREW_SCOUT: "thinky" });
  const before = requests.length;
  await call(c, "crew_recon", { question: "how does charging work?" });
  const mine = requests.slice(before);
  assert.equal(mine[0].think, true);
  assert.equal(mine[0].options.num_predict, 111);
  assert.equal(mine[1].options.num_predict, 222);
  await c.close();
});

test("a slow model returns a partial answer at the deadline instead of a timeout error", async () => {
  const c = await connect({ CREW_SCOUT: "drip" });
  const before = requests.length;
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  const out = r.content[0].text;
  assert.ok(!r.isError, out);
  assert.match(out, /partial: stopped exploring at \d/);
  assert.match(out, /\d+ turns, \d+ tool calls, [\d.]+s in model generation, 0\.0s queued, \d+ tokens generated/);
  assert.match(out, /drip final answer/);
  const mine = requests.slice(before);
  assert.equal(mine.at(-1).tools, undefined, "the last turn had tools removed");
  assert.ok(mine.length > 3, "it explored before stopping");
  await c.close();
});

test("two concurrent calls to one local worker run one at a time, and the clock starts when it is free", async () => {
  const c = await connect({ CREW_SCOUT: "gate" }); // timeoutMs 1000, each call takes ~600ms
  gateMax = 0;
  const both = Promise.all([call(c, "crew_recon", { question: "a" }), call(c, "crew_recon", { question: "b" })]);
  await sleep(250);
  const status = await call(c, "crew_status", {});
  assert.match(status, /\*\*gate\*\*.*queue: 1 running, 1 queued/);
  assert.match(status, /queue: 1 running, 1 queued \(now: crew_recon for this session, [\d.]+s so far; clear in .*, est\.\)/);
  const [x, y] = await both; // queueing 600ms + running 600ms would blow a 1s clock if it started at call time
  assert.match(x, /gate answer/);
  assert.match(y, /gate answer/);
  assert.equal(gateMax, 1, "never two in flight");
  assert.match(x + y, /queued 0\.\ds/);
  await c.close();
});

test("a call that waits longer than queueWaitMs fails fast with a clear message, and the lane is not wedged", async () => {
  const c = await connect({ CREW_SCOUT: "gateq" }); // holder takes ~600ms, waiters give up after 200ms
  gateMax = 0;
  const first = c.callTool({ name: "crew_recon", arguments: { question: "a" } });
  await sleep(100);
  const t0 = Date.now();
  const second = await c.callTool({ name: "crew_recon", arguments: { question: "b" } });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /"gateq" is busy: gave up after waiting 0\.2s in the queue \(holding it: crew_recon for this session, [\d.]+s so far; 0 other call\(s\) waiting\)/);
  assert.match(second.content[0].text, /only queues it again/);
  assert.ok(Date.now() - t0 < 500, "failed fast, did not wait for the holder");
  assert.ok(!(await first).isError);
  assert.match(await call(c, "crew_recon", { question: "c" }), /gate answer/); // lane still usable
  assert.equal(gateMax, 1);
  await c.close();
});

test("the lane is released when a call throws", async () => {
  const c = await connect({ CREW_SCOUT: "redirectq" }); // a leaked lane would surface as a queue error
  for (let i = 0; i < 2; i++) {
    const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.content[0].text, /is busy/);
  }
  assert.doesNotMatch(await call(c, "crew_status", {}), /queue: [1-9]/);
  await c.close();
});

const laneDirFor = () => path.join(process.env.XDG_STATE_HOME, "crew", "lanes", `ollama_http_127.0.0.1_${port}`);
const tickets = () => (fs.existsSync(laneDirFor()) ? fs.readdirSync(laneDirFor()).filter((n) => n.endsWith(".json")) : []);

test("two sessions share one local worker: their calls run one at a time, and the waiter is told who holds it", async () => {
  const a = await connect({ CREW_SCOUT: "gate" }); // separate server processes, like two Claude Code sessions
  const b = await connect({ CREW_SCOUT: "gate" });
  gateMax = 0;
  const notes = [];
  const first = call(a, "crew_recon", { question: "a" });
  await sleep(150);
  const second = b.callTool({ name: "crew_recon", arguments: { question: "b" } }, undefined, { onprogress: (p) => notes.push(p.message) });
  await sleep(150);
  const status = await call(b, "crew_status", {});
  assert.match(status, new RegExp(`queue: 1 running, 1 queued \\(now: crew_recon for ${path.basename(repo)}, `));
  assert.match(await first, /gate answer/);
  const r = await second;
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /gate answer/);
  assert.match(r.content[0].text, /queued 0\.\ds/);
  assert.equal(gateMax, 1, "never two in flight across sessions");
  assert.ok(notes.some((m) => m && m.includes(`is busy (crew_recon for ${path.basename(repo)}`)), notes.join(" | "));
  assert.deepEqual(tickets(), [], "tickets are removed when calls finish");
});

test("a ticket left by a dead session, or one whose heartbeat stopped, does not block the lane", async () => {
  fs.mkdirSync(laneDirFor(), { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", ""]).pid; // a process that has exited
  const old = String(Date.now() - 120_000).padStart(15, "0");
  const ticket = (name, pid) => fs.writeFileSync(path.join(laneDirFor(), name), JSON.stringify({ pid, host: os.hostname(), workspace: "ghost", tool: "crew_recon", queuedAt: Date.now() }));
  ticket(`${old}-${dead}-0.json`, dead);
  const stuck = `${old}-${process.pid}-0.json`; // alive, but its heartbeat stopped two minutes ago
  ticket(stuck, process.pid);
  const then = new Date(Date.now() - 120_000);
  fs.utimesSync(path.join(laneDirFor(), stuck), then, then);
  const c = await connect({ CREW_SCOUT: "gateq" }); // gives up after 200ms if it has to wait
  const out = await call(c, "crew_recon", { question: "a" });
  assert.match(out, /gate answer/);
  assert.deepEqual(tickets(), []);
});

test("a call already running holds the worker even when its ticket sorts after a newer one", async () => {
  fs.mkdirSync(laneDirFor(), { recursive: true });
  // Named a minute in the future, so any new ticket sorts first; but it has started, and its process is alive.
  const late = path.join(laneDirFor(), `${String(Date.now() + 60_000).padStart(15, "0")}-${process.pid}-9.json`);
  fs.writeFileSync(late, JSON.stringify({ pid: process.pid, host: os.hostname(), workspace: "other-repo", tool: "crew_review_diff", queuedAt: Date.now(), startedAt: Date.now() }));
  const c = await connect({ CREW_SCOUT: "gateq" }); // gives up after 200ms
  const notes = [];
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "a" } }, undefined, { onprogress: (p) => notes.push(p.message) });
  assert.equal(r.isError, true);
  assert.ok(notes.some((m) => m?.includes("is busy (crew_review_diff for other-repo")), notes.join(" | "));
  assert.match(r.content[0].text, /holding it: crew_review_diff for other-repo/);
  fs.rmSync(late);
  assert.match(await call(c, "crew_recon", { question: "b" }), /gate answer/);
  assert.deepEqual(tickets(), []);
});

test("a diff review goes ahead of a recon that is waiting, in the same session", async () => {
  const c = await connect({ CREW_SCOUT: "gate" });
  gateOrder = [];
  const notes = [];
  const a = call(c, "crew_recon", { question: "q-alpha" });
  await sleep(100);
  const b = c.callTool({ name: "crew_recon", arguments: { question: "q-beta" } }, undefined, { onprogress: (p) => notes.push(p.message) });
  await sleep(150);
  const r = call(c, "crew_review_diff", {});
  await Promise.all([a, b, r]);
  assert.deepEqual(gateOrder, ["q-alpha", "review", "q-beta"]);
  assert.ok(notes.some((m) => m?.includes("reviews go first until it has waited 3m00s")), notes.join(" | "));
});

test("a diff review from one session goes ahead of a recon waiting in another, and the running recon is not interrupted", async () => {
  const s1 = await connect({ CREW_SCOUT: "gate" });
  const s2 = await connect({ CREW_SCOUT: "gate" });
  gateOrder = [];
  gateMax = 0;
  const a = call(s1, "crew_recon", { question: "q-alpha" });
  await sleep(150);
  const b = call(s2, "crew_recon", { question: "q-beta" });
  await sleep(150);
  const r = call(s1, "crew_review_diff", {});
  const out = await Promise.all([a, b, r]);
  assert.match(out[0], /gate answer/);
  assert.match(out[2], /gate review/);
  assert.deepEqual(gateOrder, ["q-alpha", "review", "q-beta"]);
  assert.equal(gateMax, 1);
  assert.deepEqual(tickets(), []);
});

test("a recon that has waited reconYieldMs is passed by no one", async () => {
  const c = await connect({ CREW_SCOUT: "gateage" }); // recons yield for 100ms only
  gateOrder = [];
  const a = call(c, "crew_recon", { question: "q-alpha" });
  await sleep(100);
  const b = call(c, "crew_recon", { question: "q-beta" });
  await sleep(250); // q-beta has waited past its 100ms by now
  const r = call(c, "crew_review_diff", {});
  await Promise.all([a, b, r]);
  assert.deepEqual(gateOrder, ["q-alpha", "q-beta", "review"]);
});

test("a recon that has stopped yielding keeps its place when its session takes a new ticket", async () => {
  const s1 = await connect({ CREW_SCOUT: "gateage" }); // recons yield for 100ms only
  const s2 = await connect({ CREW_SCOUT: "gateage" });
  gateOrder = [];
  const a = call(s1, "crew_recon", { question: "q-alpha" });
  await sleep(100);
  const b = call(s1, "crew_recon", { question: "q-beta" }); // waits in s1 behind q-alpha; stops yielding at ~200ms
  await sleep(300);
  const r = call(s2, "crew_review_diff", {}); // arrives after q-beta stopped yielding, before s1 re-takes its ticket
  await Promise.all([a, b, r]);
  assert.deepEqual(gateOrder, ["q-alpha", "q-beta", "review"]);
  assert.deepEqual(tickets(), []);
});

/* ---------- v0.1.4: policy hardening ---------- */

test("policy is found from a subdirectory of the repo", async () => {
  const dir = policyRepo('{ "cloud": false }');
  const calls = codexCalls();
  const c = await connect({ CREW_SCOUT: "nope,chatgpt", CODEX_CALLS: calls });
  const sub = path.join(dir, "src");
  assert.match(await call(c, "crew_status", { workspace: sub }), /Repo policy: .*cloud:false/);
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map", workspace: sub } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /forbids cloud workers/);
  assert.ok(!fs.existsSync(calls));
  await c.close();
});

test("a nested cloud:true cannot loosen a parent's cloud:false", async () => {
  const dir = policyRepo('{ "cloud": false }');
  fs.writeFileSync(path.join(dir, "src/.crew.json"), '{ "cloud": true }');
  const c = await connect();
  assert.match(await call(c, "crew_status", { workspace: path.join(dir, "src") }), /cloud:false, local workers only/);
  await c.close();
});

test("a dangling .crew.json symlink fails closed", async () => {
  const dir = policyRepo(undefined);
  fs.symlinkSync(path.join(dir, "does-not-exist.json"), path.join(dir, ".crew.json"));
  const c = await connect();
  const out = await call(c, "crew_status", { workspace: dir });
  assert.match(out, /FAILING CLOSED/);
  assert.match(out, /dangling symlink/);
  await c.close();
});

test("a redirect from a local endpoint is refused and the prompt goes nowhere else", async () => {
  const c = await connect({ CREW_SCOUT: "redirect" });
  leaks = 0;
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  assert.equal(r.isError, true);
  assert.equal(leaks, 0);
  await c.close();
});

test("an answer cut off by the exploration token cap is redone as the final turn", async () => {
  const c = await connect({ CREW_SCOUT: "trunc" });
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.match(out, /complete answer after redo/);
  const mine = requests.slice(before);
  assert.equal(mine.length, 2);
  assert.equal(mine[1].options.num_predict, 8192);
  await c.close();
});

/* ---------- v0.1.6: empty final answer ---------- */

test("an empty final answer is retried once with think:false and yields a normal result", async () => {
  const c = await connect({ CREW_SCOUT: "emptythink" });
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.match(out, /answer after retry without thinking/);
  assert.match(out, /final answer retried without thinking/);
  const mine = requests.slice(before);
  assert.equal(mine.length, 3, "tools turn, empty final, one retry");
  assert.equal(mine[1].think, undefined, "first final turn thinks");
  assert.equal(mine[2].think, false, "the retry does not");
  assert.equal(mine[2].tools, undefined, "tools stay removed on the retry");
  assert.deepEqual(mine[2].messages, mine[1].messages, "same messages");
  await c.close();
});

test("if the retry is empty too, it stops after one retry", async () => {
  const c = await connect({ CREW_SCOUT: "alwaysempty" });
  const before = requests.length;
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /did not return structured output/);
  assert.equal(requests.slice(before).length, 3);
  await c.close();
});

test("thinkOnFinal:false sends think:false on the answer turn and does not double-ask", async () => {
  const c = await connect({ CREW_SCOUT: "emptythinkoff" });
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging" });
  const mine = requests.slice(before);
  assert.equal(mine.length, 2);
  assert.equal(mine[1].think, false);
  assert.match(out, /answer after retry without thinking/);
  assert.doesNotMatch(out, /retried without thinking \(/);
  await c.close();
});

test("a final answer cut off at the cap (done_reason length, unparseable JSON) is retried once without thinking", async () => {
  const c = await connect({ CREW_SCOUT: "cutoff" });
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.match(out, /complete answer after cut-off retry/);
  assert.match(out, /final answer was cut off; retried without thinking/);
  const mine = requests.slice(before);
  assert.equal(mine.length, 3, "tools turn, cut-off final, one retry");
  assert.equal(mine[2].think, false);
  assert.equal(mine[2].tools, undefined);
  await c.close();
});

/* ---------- v0.1.10: reformat turn ---------- */

test("a correct answer in prose gets one reformat turn: its own text, the schema, think:false, a small cap", async () => {
  const c = await connect({ CREW_SCOUT: "prose" });
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.match(out, /reformatted: chargeInvoice in src\/pay\.ts/);
  assert.match(out, /^_reformatted: /m, "diagnostics say so");
  assert.doesNotMatch(out, /did not return structured output/);
  const mine = requests.slice(before);
  assert.equal(mine.length, 4, "tools turn, prose answer, forced final (prose again), one reformat");
  assert.ok(mine[1].tools, "the first prose answer came on a normal turn (tools offered)");
  assert.equal(mine[2].tools, undefined, "a natural answer that isn't JSON is redone as the forced final turn first");
  const re = mine[3];
  assert.equal(re.messages.length, 1, "a fresh one-message conversation, not the history");
  const msg = re.messages[0].content;
  assert.ok(msg.startsWith("Return only this content as JSON matching the schema; add nothing, drop nothing."), msg.slice(0, 120));
  assert.ok(msg.includes(PROSE_RECON), "the model's own raw answer");
  assert.match(msg, /"openQuestions"/, "the recon schema");
  assert.equal(re.think, false);
  assert.equal(re.tools, undefined);
  assert.equal(mine[1].options.num_predict, 2048, "the answer turn keeps its own cap");
  assert.equal(re.options.num_predict, 512 + Math.ceil(PROSE_RECON.length / 2), "the reformat cap is sized to the answer");
  await c.close();
});

test("the reformat turn uses the calling tool's schema: a prose review becomes quote-checked findings", async () => {
  const c = await connect({ CREW_SCOUT: "prose" });
  const before = requests.length;
  const out = await call(c, "crew_review_diff", {});
  assert.match(out, /^_reformatted: /m);
  assert.match(out, /## Quote-checked findings \(1\)[\s\S]*refund does not check the amount/);
  const re = requests.slice(before).at(-1);
  assert.match(re.messages[0].content, /"findings"/);
  assert.ok(re.messages[0].content.includes(PROSE_REVIEW));
  await c.close();
});

const stateFile = (name) => path.join(process.env.XDG_STATE_HOME, "crew", name);
const lastLine = (name) => JSON.parse(fs.readFileSync(stateFile(name), "utf8").trim().split("\n").at(-1));

test("a reformat that invents a file path is rejected, and the original prose is shown", async () => {
  const c = await connect({ CREW_SCOUT: "invent" });
  const out = await call(c, "crew_review_diff", {});
  assert.match(out, /^_reformat rejected: introduced src\/billing\/mint_service\.js; the original answer is shown instead_$/m);
  assert.match(out, /did not return structured output/);
  assert.ok(out.includes(PROSE_REVIEW), "the raw answer, not the reformat");
  assert.doesNotMatch(out, /Quote-checked findings/);
  const side = lastLine("reformats.jsonl");
  assert.equal(side.outcome, "rejected");
  assert.equal(side.introduced, "src/billing/mint_service.js");
  assert.equal(side.raw, PROSE_REVIEW);
  assert.match(side.reformatted, /mint_service\.js/, "what the reformat said is kept for a later look");
  assert.equal(lastLine("usage.jsonl").reformat, "rejected");
  await c.close();
});

test("a reformat that invents an evidence quote is rejected too", async () => {
  const c = await connect({ CREW_SCOUT: "invent" });
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.match(out, /^_reformat rejected: introduced "invoice\.balance = 0;"; the original answer is shown instead_$/m);
  assert.ok(out.includes(PROSE_RECON));
  await c.close();
});

test("a reformat that only restructures is kept; the raw answer goes to the reformat log, not the usage log or the output", async () => {
  const c = await connect({ CREW_SCOUT: "prose" });
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.match(out, /^_reformatted: /m);
  assert.ok(!out.includes(PROSE_RECON), "the raw answer is not in the tool output");
  assert.doesNotMatch(out, /reformats\.jsonl/);
  const side = lastLine("reformats.jsonl");
  assert.equal(side.outcome, "ok");
  assert.equal(side.tool, "crew_recon");
  assert.equal(side.raw, PROSE_RECON);
  assert.match(side.reformatted, /"summary": ?"reformatted: chargeInvoice/);
  assert.equal(side.introduced, undefined);
  const usage = lastLine("usage.jsonl");
  assert.equal(usage.reformat, "ok");
  assert.equal(usage.ts, side.ts, "joined on ts");
  assert.ok(!fs.readFileSync(stateFile("usage.jsonl"), "utf8").includes("subtracts the amount"), "the usage log stays metadata-only");
  if (process.platform !== "win32") assert.equal(fs.statSync(stateFile("reformats.jsonl")).mode & 0o777, 0o600, "owner-only: it holds answer text"); // no POSIX modes on Windows
  await c.close();
});

test("an answer on the forced final turn gets the reformat turn too", async () => {
  const c = await connect({ CREW_SCOUT: "proseonly" });
  const before = requests.length;
  await call(c, "crew_recon", { question: "map charging" });
  const mine = requests.slice(before);
  assert.equal(mine[1].tools, undefined, "turn 2 was the forced final");
  assert.ok(mine[2].messages[0].content.startsWith("Return only this content as JSON"));
  await c.close();
});

test("if the reformat turn fails too, the original raw answer is returned as unstructured, after exactly one reformat", async () => {
  const c = await connect({ CREW_SCOUT: "proseonly" });
  const before = requests.length;
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  assert.ok(!r.isError, r.content[0].text);
  const out = r.content[0].text;
  assert.match(out, /did not return structured output/);
  assert.match(out, /^_reformat failed: /m);
  assert.ok(out.includes(PROSE_RECON), "the raw answer shown is the model's original one");
  assert.doesNotMatch(out, /As I said/, "not the failed reformat's");
  assert.equal(requests.slice(before).length, 3);
  await c.close();
});

test("if the reformat request itself errors, the task still returns the original raw answer, not an error", async () => {
  const c = await connect({ CREW_SCOUT: "proseerr" });
  const before = requests.length;
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /did not return structured output/);
  assert.match(r.content[0].text, /^_reformat failed: /m);
  assert.ok(r.content[0].text.includes(PROSE_RECON));
  assert.equal(requests.slice(before).length, 3, "the error is not retried");
  await c.close();
});

test("a lead-in with no answer, on a turn that still offered tools, is redone as the forced final turn before any reformat", async () => {
  const c = await connect({ CREW_SCOUT: "lead" });
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.match(out, /answer after the empty lead-in/);
  assert.doesNotMatch(out, /^_reformat/m, "the final turn answered in JSON: no reformat turn");
  const mine = requests.slice(before);
  assert.equal(mine.length, 3, "tool call, lead-in, forced final");
  assert.equal(mine[2].tools, undefined, "the redo is the forced final turn");
  assert.match(mine[2].messages.at(-1).content, /Stop exploring now/);
  assert.ok(!mine[2].messages.some((m) => m.role === "assistant" && m.content === LEAD_IN), "the lead-in isn't kept in the history");
  await c.close();
});

test("a lead-in on the forced final turn too is unstructured, not an empty skeleton passed off as reformatted", async () => {
  const c = await connect({ CREW_SCOUT: "leadonly" });
  const before = requests.length;
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  assert.ok(!r.isError, r.content[0].text);
  const out = r.content[0].text;
  assert.match(out, /did not return structured output/);
  assert.match(out, /^_reformat failed: /m);
  assert.ok(out.includes(LEAD_IN), "the raw lead-in is what's shown");
  assert.equal(requests.slice(before).length, 4, "tool call, lead-in, forced final, one reformat");
  await c.close();
});

test("an answer that is already valid JSON gets no reformat turn", async () => {
  const c = await connect({ CREW_SCOUT: "two" });
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.doesNotMatch(out, /reformat/);
  assert.ok(!requests.slice(before).some((b) => b.messages[0].content.startsWith("Return only this content")));
  await c.close();
});

/* ---------- v0.1.6: code maps ---------- */

function mapRepo({ map, file = "docs/CODEMAP.md", crewJson, dirty = false }) {
  const dir = policyRepo(crewJson);
  if (crewJson !== undefined) { /* committed by policyRepo */ }
  fs.mkdirSync(path.join(dir, "src/lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/lib/util.ts"), "export const u = 1;\n");
  if (map !== undefined) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), map);
  }
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("add", "."); git("commit", "-qm", "map");
  if (dirty) fs.appendFileSync(path.join(dir, "src/pay.ts"), "// changed\n");
  return dir;
}
const lastUser = (from) => requests.slice(from).at(-1).messages.find((m) => m.role === "user").content;
const firstUser = (from) => requests.slice(from)[0].messages.find((m) => m.role === "user").content;

test("code map: included in the recon prompt when present, as start-here guidance", async () => {
  const dir = mapRepo({ map: "# Map\n- `src/pay.ts`: charging and refunds\n- `src/lib/`: helpers, see src/lib/util.ts\n" });
  const c = await connect();
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging", workspace: dir });
  const prompt = firstUser(before);
  assert.match(prompt, /===== CODE MAP \(docs\/CODEMAP\.md\) =====/);
  assert.match(prompt, /charging and refunds/);
  assert.match(prompt, /never as proof/);
  assert.match(out, /code map docs\/CODEMAP\.md: sent to the scout/);
  assert.doesNotMatch(out, /stale/);
  assert.match(await call(c, "crew_status", { workspace: dir }), /Code map: docs\/CODEMAP\.md: .*no stale paths/);
  await c.close();
});

test("code map: stale paths are excluded from the prompt and reported in the output and status", async () => {
  const dir = mapRepo({
    map: "- `src/pay.ts`: charging\n- `src/gone.ts`: was deleted\n- see src/old/thing.ts and `src/pay.ts` together\n- `src/removed/`: a dir that is gone\n- `and/or` is prose, `GET /api/x` is a route, `src/*.ts` is a glob\n- `src/lib/util.ts`: still here\n",
  });
  const c = await connect();
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging", workspace: dir });
  const prompt = firstUser(before);
  assert.match(prompt, /charging/);
  assert.match(prompt, /still here/);
  assert.match(prompt, /`and\/or` is prose/, "non-paths are not mistaken for stale paths");
  assert.doesNotMatch(prompt, /src\/gone\.ts|src\/old|src\/removed/);
  assert.match(out, /excluded 3 line\(s\) naming 3 stale path\(s\): src\/gone\.ts, src\/old\/thing\.ts, src\/removed/);
  assert.match(await call(c, "crew_status", { workspace: dir }), /Code map: .*3 stale path\(s\) excluded: src\/gone\.ts/);
  await c.close();
});

test("code map: no map means no map section and no note", async () => {
  const dir = mapRepo({});
  const c = await connect();
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging", workspace: dir });
  assert.doesNotMatch(firstUser(before), /CODE MAP/);
  assert.doesNotMatch(out, /code map/i);
  assert.match(await call(c, "crew_status", { workspace: dir }), /Code map: none/);
  await c.close();
});

test("code map: an oversized map is truncated to the cap with a note", async () => {
  const lines = Array.from({ length: 600 }, (_, i) => `- \`src/pay.ts\`: entry number ${i} describing the charging path`);
  const dir = mapRepo({ map: lines.join("\n") });
  const c = await connect();
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging", workspace: dir });
  const prompt = firstUser(before);
  const body = prompt.split("===== CODE MAP (docs/CODEMAP.md) =====")[1].split("===== END CODE MAP =====")[0];
  assert.ok(body.length < 8_400, `map body was ${body.length} chars`);
  assert.match(prompt, /entry number 0 /);
  assert.doesNotMatch(prompt, /entry number 599 /);
  assert.match(out, /truncated from \d{5}/);
  await c.close();
});

test("code map: crew_review_diff gets it too, and .crew.json can name another file", async () => {
  const dir = mapRepo({ map: "- `src/pay.ts`: the review map\n", file: "MAP.md", crewJson: '{ "map": "MAP.md" }', dirty: true });
  const c = await connect();
  const before = requests.length;
  const out = await call(c, "crew_review_diff", { workspace: dir });
  assert.match(firstUser(before), /===== CODE MAP \(MAP\.md\) =====[\s\S]*the review map/);
  assert.match(out, /code map MAP\.md: sent to the scout/);
  await c.close();
});

test("code map: a configured map outside the workspace is refused", async () => {
  const dir = mapRepo({ crewJson: '{ "map": "../outside.md" }' });
  fs.writeFileSync(path.join(dir, "..", "outside.md"), "- secret\n");
  const c = await connect();
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging", workspace: dir });
  assert.doesNotMatch(firstUser(before), /secret|CODE MAP/);
  assert.match(out, /code map \.\.\/outside\.md not used: Path escapes workspace/);
  await c.close();
  const dir2 = mapRepo({ crewJson: '{ "map": 5 }' });
  assert.match(await call(await connect(), "crew_status", { workspace: dir2 }), /FAILING CLOSED/);
});

test("code map: a :line suffix and a markdown link are checked as paths", async () => {
  const dir = mapRepo({
    map: "- `src/pay.ts:42`: real file with a line\n- `src/gone.ts:42`: stale file with a line\n- [charging](src/pay.ts) is a live link\n- [old](src/dead.ts#L3) is a dead link\n- [site](https://example.com/src/nope.ts) is a URL\n",
  });
  const c = await connect();
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging", workspace: dir });
  const prompt = firstUser(before);
  assert.match(prompt, /real file with a line/);
  assert.match(prompt, /live link/);
  assert.match(prompt, /is a URL/, "URLs are not repo paths");
  assert.doesNotMatch(prompt, /stale file with a line|dead link/);
  assert.match(out, /excluded 2 line\(s\) naming 2 stale path\(s\): src\/dead\.ts, src\/gone\.ts/);
  await c.close();
});

/* ---------- v0.1.7: malformed tool calls ---------- */

test("a 500 tool-call parse error is retried once with a nudge and the task succeeds", async () => {
  const c = await connect({ CREW_SCOUT: "malformed" });
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.match(out, /answer after malformed retry/);
  assert.match(out, /_malformed tool call retried_/);
  const mine = requests.slice(before);
  assert.equal(mine.length, 3, "failed turn, nudged retry, final answer");
  assert.ok(!mine[0].messages.some((m) => /malformed/.test(m.content)), "first try has no nudge");
  const last = mine[1].messages[mine[1].messages.length - 1];
  assert.equal(last.role, "user");
  assert.match(last.content, /malformed.*valid tool-call syntax/s);
  assert.deepEqual(mine[1].tools?.map((t) => t.function.name), mine[0].tools?.map((t) => t.function.name), "tools stay available on the retry");
  assert.ok(!mine[2].messages.some((m) => /malformed/.test(m.content)), "the nudge does not linger in later turns");
  await c.close();
});

test("a model that is always malformed fails after exactly two retries", async () => {
  const c = await connect({ CREW_SCOUT: "badtool" });
  const before = requests.length;
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /XML syntax error/);
  assert.match(r.content[0].text, /gave up: all 2 malformed tool call retries for this task were used/);
  assert.equal(requests.slice(before).length, 3, "first try and two nudged retries");
  await c.close();
});

test("two malformed tool calls in a row, then a good one: the task succeeds, each retry nudged", async () => {
  malformedPlan = [true, true];
  const c = await connect({ CREW_SCOUT: "plan" });
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "map charging" });
  assert.match(out, /answer after the planned malformed calls/);
  assert.match(out, /_malformed tool call retried ×2_/);
  const mine = requests.slice(before);
  assert.equal(mine.length, 4, "failed, failed, good tool call, answer");
  const nudged = (b) => /malformed.*valid tool-call syntax/s.test(b.messages.at(-1).content);
  assert.deepEqual(mine.map(nudged), [false, true, true, false], "both retries carry the nudge; it doesn't linger");
  await c.close();
});

test("three malformed tool calls in a row fail the task", async () => {
  malformedPlan = [true, true, true];
  const c = await connect({ CREW_SCOUT: "plan" });
  const before = requests.length;
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /XML syntax error/);
  assert.equal(requests.slice(before).length, 3);
  malformedPlan = [];
  await c.close();
});

test("the two retries are per task, not per turn: one on turn 1 and two on turn 2 fail it", async () => {
  malformedPlan = [true, false, true, true];
  const c = await connect({ CREW_SCOUT: "plan" });
  const before = requests.length;
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  assert.equal(r.isError, true);
  assert.equal(requests.slice(before).length, 4);
  malformedPlan = [];
  await c.close();
});

test("other 500s are not retried", async () => {
  const c = await connect({ CREW_SCOUT: "crash" });
  const before = requests.length;
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "map charging" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unexpectedly stopped/);
  assert.equal(requests.slice(before).length, 1);
  await c.close();
});

/* ---------- v0.1.7: model names ---------- */

test("a configured model that differs from the installed one only in tag case is used, and sent, as installed", async () => {
  const c = await connect({ CREW_SCOUT: "tagcase" });
  const before = requests.length;
  const out = await call(c, "crew_recon", { question: "how does charging work?" });
  assert.match(out, /_via tagcase \(tagcase-model:Q4_K_M\)/);
  const mine = requests.slice(before);
  assert.ok(mine.length > 0);
  assert.ok(mine.every((r) => r.model === "tagcase-model:Q4_K_M"), mine.map((r) => r.model).join());
  assert.match(await call(c, "crew_status", {}), /tagcase-model:Q4_K_M @ .*\(configured as tagcase-model:q4_k_m\)/);
  await c.close();
});

test("a model that isn't installed lists the closest installed names, not the first few", async () => {
  const c = await connect({ CREW_SCOUT: "typo" });
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "x" } });
  assert.equal(r.isError, true);
  const msg = r.content[0].text;
  assert.match(msg, /model "test-mode" not pulled/);
  assert.match(msg, /closest installed: test-model:latest/);
  const list = /closest installed: ([^)]*)\)/.exec(msg)[1].split(", ");
  assert.equal(list.length, 3);
  await c.close();
});

const usageFile = () => path.join(process.env.XDG_STATE_HOME, "crew", "usage.jsonl");

test("instructions tell Claude to quote the via line", async () => {
  const c = await connect();
  assert.match(c.getInstructions() || "", /quote that line verbatim/);
  await c.close();
});

test("calls are logged as metadata only, and crew_stats and status report them", async () => {
  fs.rmSync(path.dirname(usageFile()), { recursive: true, force: true });
  const c = await connect();
  const recon = await call(c, "crew_recon", { question: "map charging" });
  assert.match(recon.split("\n")[0], /^_via /); // via stays first
  await call(c, "crew_review_diff", {});
  await call(c, "crew_second_opinion", { subject: "Is chargeInvoice safe?" });

  const rows = fs.readFileSync(usageFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.tool), ["crew_recon", "crew_review_diff", "crew_second_opinion"]);
  const [r1, r2, r3] = rows;
  assert.equal(r1.worker, "local");
  assert.equal(r1.local, true);
  assert.equal(r1.workspace, path.basename(fs.realpathSync(repo))); // name only, not the path
  assert.ok(r1.charsRead > 0 && r1.toolCalls === 1); // recon searched
  assert.ok(r2.filesRead >= 1 && r2.charsRead > 0); // review read src/pay.ts
  assert.deepEqual([r1.quoteChecked, r1.unverified], [1, 1]);
  assert.deepEqual([r2.quoteChecked, r2.unverified], [1, 2]);
  assert.equal(r3.local, false);
  assert.equal(r3.charsRead, 0);
  // No prompt, code or answer text anywhere in the log.
  const raw = fs.readFileSync(usageFile(), "utf8");
  assert.ok(!raw.includes("chargeInvoice") && !raw.includes("invoice.balance") && !raw.includes(repo));

  const stats = await call(c, "crew_stats", { period: "today" });
  assert.match(stats, /\*\*local\*\*.*2 call\(s\).*files read.*chars read.*tokens generated.*2 quote-checked, 3 unverified/);
  assert.match(stats, /\*\*chatgpt\*\*.*cloud\): 1 call\(s\).*calls and time only/);
  assert.match(stats, /ESTIMATE: context kept out of Claude ≈ [\d,]+ tokens \(characters read by local workers ÷ 4\)/);
  assert.match(await call(c, "crew_status", {}), /^today: 3 call\(s\) · local 2 .* cloud 1 .*\(estimate\)$/m);
  await c.close();
});

test("a timed-out call is logged with outcome timeout", async () => {
  fs.rmSync(path.dirname(usageFile()), { recursive: true, force: true });
  const c = await connect({ CREW_SCOUT: "slow" });
  const res = await c.callTool({ name: "crew_recon", arguments: { question: "x" } });
  assert.equal(res.isError, true);
  const rows = fs.readFileSync(usageFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].worker, "slow");
  assert.equal(rows[0].outcome, "timeout");
  assert.equal(rows[0].tool, "crew_recon");
  await c.close();
});
