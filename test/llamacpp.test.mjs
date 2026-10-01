// llama-server (OpenAI-compatible) as a local worker, against a fake server that records every request body.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Server children inherit this, so tests never write to the real ~/.local/state/crew.
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crew-state-"));
const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "index.js");

let llama, port, sandbox, repo, cfgFile;
let requests = []; // {url, body}

const recon = (summary) => JSON.stringify({ summary, files: [{ path: "src/pay.ts", why: "x" }], functions: [], coverage: [], risks: [], openQuestions: [] });

before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "crew-llamacpp-"));
  repo = path.join(sandbox, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/pay.ts"), "export function chargeInvoice(invoice, amount) {\n  invoice.balance -= amount;\n  return invoice;\n}\n");
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("add", "."); git("commit", "-qm", "init");

  llama = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    if (req.method === "GET" && req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "qwen-test" }] })); return; }
    const body = JSON.parse(b);
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    const used = body.messages.some((m) => m.role === "tool");
    const reply = (message, finish = "stop") => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...message }, finish_reason: finish }], usage: { completion_tokens: 40 } }));
    };
    const tool = () => reply({ content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "list_files", arguments: "{}" } }] }, "tool_calls");
    if (body.tools && !used) return tool();
    if (body.model === "prose-llama") { // prose on the answer turn, JSON on the reformat turn
      if (body.messages[0].content.startsWith("Return only this content as JSON")) return reply({ content: recon("reformatted from prose") });
      return reply({ content: "Charging is chargeInvoice in src/pay.ts." });
    }
    if (body.model.startsWith("empty-")) {
      // The answer turn: with thinking on, all of the budget goes to reasoning and content is empty.
      if (body.chat_template_kwargs?.enable_thinking === false) return reply({ content: recon("answer after retry without thinking") });
      return reply({ content: "", reasoning_content: "pondering…" }, "length");
    }
    return reply({ content: recon(`answer from ${body.model}`) });
  });
  await new Promise((r) => llama.listen(0, "127.0.0.1", r));
  port = llama.address().port;
  const base = `http://127.0.0.1:${port}/v1`;
  cfgFile = path.join(sandbox, "crew.json");
  fs.writeFileSync(cfgFile, JSON.stringify({
    workers: Object.fromEntries(Object.entries({
      llama: { provider: "openai", label: "llama-server", baseUrl: base, model: "qwen-test", thinkingParam: "chat_template_kwargs" },
      plain: { provider: "openai", label: "plain", baseUrl: base, model: "qwen-test" },
      none: { provider: "openai", label: "none", baseUrl: base, model: "qwen-test", thinkingParam: "none" },
      finaloff: { provider: "openai", label: "finaloff", baseUrl: base, model: "qwen-test", thinkingParam: "chat_template_kwargs", thinkOnFinal: false },
      toolson: { provider: "openai", label: "toolson", baseUrl: base, model: "qwen-test", thinkingParam: "chat_template_kwargs", thinkOnTools: true },
      emptyfinal: { provider: "openai", label: "emptyfinal", baseUrl: base, model: "empty-think", thinkingParam: "chat_template_kwargs" },
      emptynone: { provider: "openai", label: "emptynone", baseUrl: base, model: "empty-none" },
      prose: { provider: "openai", label: "prose", baseUrl: base, model: "prose-llama", thinkingParam: "chat_template_kwargs" },
      keyed: { provider: "openai", label: "keyed", baseUrl: base, model: "qwen-test", apiKeyEnv: "LLAMA_TEST_KEY" },
      dead: { provider: "openai", label: "dead llama", baseUrl: "http://127.0.0.1:1/v1", model: "qwen-test", thinkingParam: "chat_template_kwargs" },
    }).map(([k, w]) => [k, { maxTurns: 2, ...w }])), // turn 2 is the forced final turn
    roles: { scout: ["llama"], reviewer: ["llama"] },
  }));
});

after(() => { llama?.closeAllConnections(); llama?.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });

const opened = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((c) => c.close().catch(() => {}))); });

async function connect(env = {}, config = cfgFile) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: { ...process.env, CREW_WORKSPACE: repo, CREW_CONFIG: config, XDG_CONFIG_HOME: path.join(sandbox, ".no-user-config"), ...env },
    stderr: "pipe",
  });
  const c = new Client({ name: "test", version: "0" });
  opened.push(c);
  await c.connect(transport);
  return c;
}
const call = async (c, name, args) => (await c.callTool({ name, arguments: args })).content[0].text;
const chat = () => requests.filter((r) => r.url === "/v1/chat/completions").map((r) => r.body);
const think = (b) => b.chat_template_kwargs?.enable_thinking;

async function recon1(worker, env = {}) {
  requests = [];
  const c = await connect({ CREW_SCOUT: worker, ...env });
  const out = await call(c, "crew_recon", { question: "how does charging work?" });
  return { out, bodies: chat() };
}

test("thinkingParam chat_template_kwargs: enable_thinking false on exploration, true on the final turn", async () => {
  const { out, bodies } = await recon1("llama");
  assert.match(out, /_via llama-server \(qwen-test\)/);
  assert.match(out, /answer from qwen-test/);
  assert.equal(bodies.length, 2, "tool turn, final turn");
  assert.ok(bodies[0].tools?.length, "exploration turn has tools");
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: false });
  assert.equal(bodies[1].tools, undefined, "final turn has no tools");
  assert.deepEqual(bodies[1].chat_template_kwargs, { enable_thinking: true });
  assert.equal(bodies[0].model, "qwen-test");
  assert.equal(bodies[0].think, undefined, "no Ollama-only fields on an OpenAI request");
  assert.equal(bodies[0].options, undefined);
});

test("default (no thinkingParam) and thinkingParam none send nothing about thinking", async () => {
  for (const w of ["plain", "none"]) {
    const { bodies } = await recon1(w);
    assert.equal(bodies.length, 2, w);
    for (const b of bodies) assert.ok(!("chat_template_kwargs" in b), `${w}: ${JSON.stringify(b.chat_template_kwargs)}`);
  }
});

test("thinkOnFinal:false sends enable_thinking false on the final turn too", async () => {
  const { bodies } = await recon1("finaloff");
  assert.equal(think(bodies[0]), false);
  assert.equal(think(bodies[1]), false);
  assert.equal(bodies.length, 2, "no retry is needed, nor made");
});

test("thinkOnTools:true turns thinking on for exploration turns", async () => {
  const { bodies } = await recon1("toolson");
  assert.equal(think(bodies[0]), true);
  assert.equal(think(bodies[1]), true);
});

test("an empty final answer (reasoning ate the budget) is retried once without thinking", async () => {
  const { out, bodies } = await recon1("emptyfinal");
  assert.match(out, /answer after retry without thinking/);
  assert.match(out, /final answer retried without thinking/);
  assert.deepEqual(bodies.map(think), [false, true, false], "explore, final with thinking, retry without");
  assert.equal(bodies[2].tools, undefined);
  assert.deepEqual(bodies[2].messages, bodies[1].messages, "same messages on the retry");
});

test("a prose final answer gets one reformat turn with enable_thinking false and a max_tokens cap", async () => {
  const { out, bodies } = await recon1("prose");
  assert.match(out, /reformatted from prose/);
  assert.match(out, /^_reformatted: /m);
  assert.equal(bodies.length, 3);
  assert.equal(think(bodies[2]), false);
  assert.equal(bodies[2].max_tokens, 512 + Math.ceil("Charging is chargeInvoice in src/pay.ts.".length / 2));
  assert.equal(bodies[1].max_tokens, undefined, "other turns still send no cap");
  assert.equal(bodies[2].messages.length, 1);
});

test("without thinkingParam an empty final answer is not retried (thinking can't be switched off)", async () => {
  requests = [];
  const c = await connect({ CREW_SCOUT: "emptynone" });
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "x" } });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /did not return structured output/);
  assert.equal(chat().length, 2);
});

test("the API key is sent as a bearer token, and a missing key is reported", async () => {
  requests = [];
  let c = await connect({ CREW_SCOUT: "keyed", LLAMA_TEST_KEY: "sekret" });
  await call(c, "crew_recon", { question: "x" });
  assert.ok(requests.length && requests.every((r) => r.auth === "Bearer sekret"));
  await c.close();
  c = await connect({ CREW_SCOUT: "keyed", LLAMA_TEST_KEY: "" });
  const r = await c.callTool({ name: "crew_recon", arguments: { question: "x" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /LLAMA_TEST_KEY is not set/);
});

test("a local openai worker that is down is skipped, so the chain falls through to the next worker", async () => {
  requests = [];
  const c = await connect({ CREW_SCOUT: "dead,llama" });
  const out = await call(c, "crew_recon", { question: "x" });
  assert.match(out, /_via llama-server/);
  assert.match(out, /fell back past: dead: server not reachable at http:\/\/127\.0\.0\.1:1\/v1/);
  assert.match(await call(c, "crew_status", {}), /❌ \*\*dead\*\* \(openai\): server not reachable/);
  const only = await connect({ CREW_SCOUT: "dead" });
  const r = await only.callTool({ name: "crew_recon", arguments: { question: "x" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not reachable/);
});

test("crew_status shows a reachable llama-server worker as available", async () => {
  const c = await connect({ CREW_SCOUT: "llama" });
  assert.match(await call(c, "crew_status", {}), new RegExp(`✅ \\*\\*llama\\*\\* \\(openai\\): qwen-test @ http://127\\.0\\.0\\.1:${port}/v1`));
});

test("a bad thinkingParam is rejected with the worker's name", async () => {
  const bad = path.join(sandbox, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ workers: { llama: { provider: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "m", thinkingParam: "enable_thinking" } }, roles: { scout: ["llama"], reviewer: ["llama"] } }));
  const c = await connect({}, bad);
  const r = await c.callTool({ name: "crew_status", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Worker "llama": thinkingParam must be "chat_template_kwargs" or "none"/);
});

test("examples/config.llamacpp.json is valid: a local openai worker at 127.0.0.1:8080/v1", async () => {
  const ex = JSON.parse(fs.readFileSync(path.join(here, "..", "examples", "config.llamacpp.json"), "utf8"));
  const w = ex.workers.llamacpp;
  assert.equal(w.provider, "openai");
  assert.equal(w.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(w.thinkingParam, "chat_template_kwargs");
  assert.ok(ex.roles.scout.includes("llamacpp"));
  assert.match(ex._comment, /^EXPERIMENTAL: tested against a fake OpenAI-compatible server/, "the example carries the experimental note");
  // And crew accepts it and calls it local (cloud:false repos may use it).
  fs.writeFileSync(path.join(repo, ".crew.json"), '{ "cloud": false }');
  try {
    const c = await connect({}, path.join(here, "..", "examples", "config.llamacpp.json"));
    const status = await call(c, "crew_status", {});
    assert.match(status, /llamacpp\*\* \(openai\)/);
    assert.doesNotMatch(status, /excluded by repo policy \(cloud worker\)[^\n]*llamacpp|llamacpp[^\n]*excluded by repo policy/);
  } finally {
    fs.rmSync(path.join(repo, ".crew.json"), { force: true });
  }
});
