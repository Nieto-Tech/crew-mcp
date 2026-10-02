// Integration: the bench engine against a fake Ollama, a small synthetic repo and a task file written next to it.
// Checks the plumbing: task file loading, repo resolution, diff plants and preflight, worktree lifecycle,
// per-model env, /api/ps, JSON + table, and --check. Nothing here comes from a real repo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkTaskFile, loadTaskFile, runBench } from "../bench/run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = "src/shop/webhook.ts";
const HOOK_SRC = `function isDuplicate(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "UNIQUE_VIOLATION";
}

export async function recordPayment(db: Db, eventId: string): Promise<void> {
  try {
    await db.insert("payments", { event_id: eventId });
  } catch (err) {
    if (isDuplicate(err)) {
      // The unique index on event_id caught a redelivery: already recorded, so acknowledge.
      return;
    }
    throw err;
  }
  await refreshOrderTotals(db, eventId);
}
`;

const STOCK = "src/shop/stock.ts";
const STOCK_SRC = `export async function reserve(db: Db, sku: string, qty: number) {
  await db.begin();
  try {
    const row = await readStock(db, sku, { forUpdate: true });
    if (!row || row.available < qty) {
      await db.rollback();
      return null;
    }
    await db.commit();
  } finally {
    db.release();
  }
}
`;
const TOTALS = "src/shop/totals.ts";
const MIG = "db/migrations/001_payments.sql";

const openaiBodies = []; // bodies of /v1/chat/completions (the llama-server worker)
let ollama, url, repo, outDir, sandbox, tasksFile;
const chatModels = []; // model of every /api/chat call
const chatCtx = []; // num_ctx of every /api/chat call
let flakyFailed = false;
let proseAnswered = false;
const generateCalls = []; // {model, keep_alive} of every /api/generate call
const resident = new Set();

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const noUserConfig = () => ({ XDG_CONFIG_HOME: path.join(sandbox, "no-user-config") });

// The synthetic task file: two planted bugs and a recon question, the shape a real one has.
const TASK_FILE = (repoUrl, ref) => `export default {
  repo: { url: ${JSON.stringify(repoUrl)}${ref ? `, ref: ${JSON.stringify(ref)}` : ""} },
  tasks: [
    { id: "review", name: "planted bug", kind: "review", plant: "plants/dedupe.diff", anchor: ${JSON.stringify(HOOK)},
      about: "duplicates/redelivery", match: (w) => /duplicate|re-?deliver/i.exec(w)?.[0] ?? null,
      cases: [{ name: "dup", checked: [{ file: ${JSON.stringify(HOOK)}, claim: "a redelivered event throws" }], pass: true }] },
    { id: "review_hard", name: "planted bug (hard)", kind: "review", plant: "plants/lock.diff", anchor: ${JSON.stringify(STOCK)},
      about: "the concurrency consequence", match: (w) => /concurren\\w*[^.]*\\bboth\\b/i.exec(w)?.[0] ?? null,
      nearMiss: { test: (w) => /for ?update|row lock/i.test(w), reason: "names the removed lock, not its consequence" } },
    { id: "recon", name: "recon", kind: "recon", question: "how does a payment webhook become a payments row",
      expect: [
        { name: "webhook.ts", test: (p) => /(^|\\/)webhook\\.ts$/.test(p) },
        { name: "totals.ts", test: (p) => /(^|\\/)totals\\.ts$/.test(p) },
        { name: "migration adding the unique index", test: (p) => /migrations\\/[^/]*_payments\\.sql$/.test(p) },
      ],
      cases: [{ name: "all three", files: [${JSON.stringify(HOOK)}, ${JSON.stringify(TOTALS)}, ${JSON.stringify(MIG)}], pass: true }] },
  ],
};
`;

/** Write a task file (and its plants, made from the repo by `git diff`) into dir. */
function writeTaskFile(dir, repoUrl, ref) {
  fs.mkdirSync(path.join(dir, "plants"), { recursive: true });
  const plant = (file, from, to, out) => {
    const abs = path.join(repo, file);
    const orig = fs.readFileSync(abs, "utf8");
    fs.writeFileSync(abs, orig.replace(from, to));
    fs.writeFileSync(path.join(dir, "plants", out), git(repo, "diff", "--", file) + "\n");
    fs.writeFileSync(abs, orig);
  };
  plant(HOOK, /    if \(isDuplicate\(err\)\) \{\n[\s\S]*?\n    \}\n/, "", "dedupe.diff");
  plant(STOCK, "readStock(db, sku, { forUpdate: true })", "readStock(db, sku)", "lock.diff");
  const file = path.join(dir, "tasks.mjs");
  fs.writeFileSync(file, TASK_FILE(repoUrl, ref));
  return file;
}

before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "crew-benchtest-"));
  repo = path.join(sandbox, "repo");
  fs.mkdirSync(repo);
  for (const [f, body] of Object.entries({
    [HOOK]: HOOK_SRC,
    [STOCK]: STOCK_SRC,
    [TOTALS]: "export function refreshOrderTotals() {}\n",
    [MIG]: "ALTER TABLE payments ADD UNIQUE INDEX uk_payments_event (event_id);\n",
  })) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), body);
  }
  git(repo, "init", "-q"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  git(repo, "add", "."); git(repo, "commit", "-qm", "init");
  outDir = path.join(sandbox, "results");
  tasksFile = writeTaskFile(path.join(sandbox, "tasks"), "../repo"); // a path, relative to the task file

  const reconFiles = (good) => (good ? [HOOK, TOTALS, MIG] : [HOOK]);
  const reconJson = (good = true) => JSON.stringify({ summary: "map", files: reconFiles(good).map((path) => ({ path, why: "x" })), functions: [], coverage: [], risks: [], openQuestions: [] });
  const goodHard = { severity: "high", category: "concurrency", file: STOCK, line: 4, claim: "the stock read lost its FOR UPDATE row lock, so two concurrent reservations can both take the last units", evidence: "const row = await readStock(db, sku);", suggestion: "restore forUpdate" };
  const goodEasy = { severity: "high", category: "bug", file: HOOK, line: 12, claim: "a redelivered event now throws on the duplicate insert", evidence: "await refreshOrderTotals(db, eventId);", suggestion: "restore the duplicate check" };

  ollama = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    const json = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (req.url === "/v1/models") return json({ data: [{ id: "qwen-llama" }] });
    if (req.url === "/v1/chat/completions") { // a llama-server-style worker that always gives the right answers
      const body = JSON.parse(b);
      openaiBodies.push(body);
      const user = body.messages.find((m) => m.role === "user").content;
      const used = body.messages.some((m) => m.role === "tool");
      const msg = (message) => json({ choices: [{ message: { role: "assistant", ...message }, finish_reason: "stop" }], usage: { completion_tokens: 30 } });
      if (body.tools && !used) return msg({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } }] });
      if (user.includes("Reconnaissance request")) return msg({ content: reconJson() });
      return msg({ content: JSON.stringify({ summary: "s", findings: [user.includes("forUpdate") ? goodHard : goodEasy] }) });
    }
    if (req.url === "/api/tags") return json({ models: [{ name: "fake-good" }, { name: "fake-bad" }, { name: "fake-flaky" }, { name: "fake-prose" }, { name: "Case-Model:Q4_K_M" }] });
    if (req.url === "/api/ps") return json({ models: [...resident].map((name) => ({ name, model: name, size: 20e9, size_vram: name === "fake-bad" ? 15e9 : 20e9, context_length: 65536 })) });
    const body = b ? JSON.parse(b) : {};
    if (req.url === "/api/generate") {
      generateCalls.push({ model: body.model, keep_alive: body.keep_alive, num_ctx: body.options?.num_ctx });
      if (body.model === "fake-missing") { res.statusCode = 404; return json({ error: "model 'fake-missing' not found" }); }
      if (body.keep_alive === 0) resident.delete(body.model); else resident.add(body.model);
      return json({ done: true });
    }
    if (body.model === "fake-flaky" && !flakyFailed) { // one malformed tool call, once
      flakyFailed = true;
      res.statusCode = 500;
      return json({ error: "XML syntax error on line 3: element <parameter> closed by </function>" });
    }
    chatModels.push(body.model);
    chatCtx.push(body.options?.num_ctx);
    resident.add(body.model);
    const user = body.messages.find((m) => m.role === "user").content;
    const used = body.messages.some((m) => m.role === "tool");
    const reply = (content, extra = {}) => json({ message: { role: "assistant", content, ...extra }, eval_count: 100, done_reason: "stop" });
    const good = body.model !== "fake-bad";
    if (body.model === "fake-prose" && user.startsWith("Return only this content as JSON")) return reply(reconJson()); // crew's reformat turn
    if (user.includes("Reconnaissance request")) {
      if (!used) return reply("", { tool_calls: [{ function: { name: "list_files", arguments: {} } }] });
      if (body.model === "fake-prose" && !proseAnswered) { // prose until the forced final turn, once
        if (!body.tools) proseAnswered = true;
        return reply(`Three files: ${HOOK}, ${TOTALS} and ${MIG}.`);
      }
      return reply(reconJson(good));
    }
    if (user.includes("Review this change") && user.includes("forUpdate")) { // the hard diff
      if (!used) return reply("", { tool_calls: [{ function: { name: "read_file", arguments: { path: STOCK } } }] });
      const f = good ? goodHard : { severity: "low", category: "style", file: STOCK, line: 4, claim: "an argument was dropped", evidence: "const row = await readStock(db, sku);" };
      return reply(JSON.stringify({ summary: "s", findings: [f] }));
    }
    if (user.includes("Review this change")) {
      if (!used) return reply("", { tool_calls: [{ function: { name: "read_file", arguments: { path: HOOK } } }] });
      const f = good ? goodEasy : { ...goodEasy, claim: "duplicate redelivery breaks", evidence: "this quoted line does not exist anywhere in the code" };
      return reply(JSON.stringify({ summary: "s", findings: [f] }));
    }
    return reply("{}");
  });
  await new Promise((r) => ollama.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${ollama.address().port}`;
});

after(() => { ollama?.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });

test("bench runs every task per model, scores them, cleans up, and writes JSON", async () => {
  resident.add("bystander"); // someone else's loaded model: must be unloaded so GPU% is clean
  const before = git(repo, "status", "--porcelain");
  const logs = [];
  const { doc, file, table } = await runBench({
    tasksFile, ollamaUrl: url, outDir, baseline: "fake-good", models: ["fake-bad", "fake-missing", "fake-good"],
    runs: 2, env: noUserConfig(), log: (m) => logs.push(m),
  });

  // The repo came from the task file's relative path; the plants were checked before any model ran.
  assert.equal(doc.repo.path, repo);
  assert.equal(doc.repo.url, "../repo");
  assert.equal(doc.tasksFile, tasksFile);
  assert.ok(logs.some((l) => l === "preflight ok: review: dedupe.diff applies (+0 −4 in src/shop/webhook.ts)"), logs.join("\n"));
  assert.ok(logs.some((l) => l.startsWith("preflight ok: review_hard: lock.diff applies (+1 −1")));
  assert.ok(logs.some((l) => l === "preflight ok: recon: all 3 expected files tracked"));

  // Baseline first, duplicates folded, a model that can't load is an error row and doesn't stop the run.
  assert.deepEqual(doc.models.map((m) => m.model), ["fake-good", "fake-bad", "fake-missing"]);
  assert.equal(doc.models[0].baseline, true);
  assert.match(doc.models[2].error, /model not installed \(closest installed: fake-/);

  const good = Object.fromEntries(Object.entries(doc.models[0].tasks).map(([k, t]) => [k, t.runs[0]]));
  const bad = Object.fromEntries(Object.entries(doc.models[1].tasks).map(([k, t]) => [k, t.runs[0]]));

  // Two runs per task, summarised, in the task file's order.
  assert.equal(doc.runs, 2);
  assert.deepEqual(doc.taskNames, [["review", "planted bug"], ["review_hard", "planted bug (hard)"], ["recon", "recon"]]);
  assert.deepEqual(Object.keys(doc.models[0].tasks), ["review", "review_hard", "recon"]);
  assert.equal(doc.models[0].tasks.review.runs.length, 2);
  assert.deepEqual(
    { n: doc.models[0].tasks.review.n, passes: doc.models[0].tasks.review.passes, passRate: doc.models[0].tasks.review.passRate },
    { n: 2, passes: 2, passRate: 1 }
  );
  assert.equal(doc.models[1].tasks.review.passes, 0);
  assert.ok(doc.models[0].tasks.review.medianWallMs > 0);
  assert.equal(doc.models[0].tasks.review.medianTurns, 2);

  // The hard task: the good model names the consequence, the bad one only notes a dropped argument.
  assert.equal(doc.models[0].tasks.review_hard.passes, 2);
  assert.equal(good.review_hard.quoteChecked, 1);
  assert.match(good.review_hard.reason, /matched "concurrent reservations can both" in src\/shop\/stock\.ts/);
  assert.equal(doc.models[1].tasks.review_hard.passes, 0);
  assert.match(bad.review_hard.reason, /about the concurrency consequence/);

  // Default context window = the worker's configured numCtx (crew's built-in 65536 with no user config).
  assert.equal(doc.numCtx, 65536);
  assert.equal(doc.ctxSource, "worker config");
  assert.ok(chatCtx.length && chatCtx.every((c) => c === 65536), `chat num_ctx: ${chatCtx}`);
  assert.equal(good.review.pass, true, JSON.stringify(good.review));
  assert.equal(good.recon.pass, true, JSON.stringify(good.recon));
  assert.equal(good.recon.found, 3);
  assert.equal(good.review.quoteChecked, 1);
  assert.equal(bad.review.pass, false);
  assert.equal(bad.review.quoteChecked, 0);
  assert.equal(bad.review.unverified, 1);
  assert.match(bad.review.reason, /only in Unverified/);
  assert.equal(bad.recon.pass, false);
  assert.equal(bad.recon.found, 1);

  // Metrics came through the real server's via line.
  for (const t of [good.review, good.recon]) {
    assert.equal(t.turns, 2);
    assert.equal(t.toolCalls, 1);
    assert.equal(t.tokens, 200);
    assert.ok(t.wallMs > 0);
    assert.equal(t.ranModel, "fake-good");
    assert.deepEqual(t.retries, { malformed: 0, final: null, explorationRedos: 0 });
  }
  assert.deepEqual({ sizeGB: good.review.ollama.sizeGB, gpuPct: good.review.ollama.gpuPct }, { sizeGB: 20, gpuPct: 100 });
  assert.equal(bad.review.ollama.gpuPct, 75);

  // The right model was used per run, at the benchmark's context size, with nothing else left loaded.
  assert.deepEqual([...new Set(chatModels)], ["fake-good", "fake-bad"]);
  assert.ok(generateCalls.some((c) => c.model === "fake-good" && c.num_ctx === 65536 && c.keep_alive === "1h"));
  assert.ok(generateCalls.some((c) => c.model === "bystander" && c.keep_alive === 0));
  assert.equal(resident.size, 0, "everything unloaded at the end");

  // The real repo was not touched and the throwaway worktree is gone.
  assert.equal(git(repo, "status", "--porcelain"), before);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
  const wt = /^worktree (\S+) @/.exec(logs.find((l) => l.startsWith("worktree ")))[1];
  assert.ok(wt.startsWith(os.tmpdir()) && !fs.existsSync(wt), "worktree lived under tmp and is gone");

  // Results file + table.
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.repo.sha, git(repo, "rev-parse", "HEAD"));
  assert.equal(saved.repo.ref, "HEAD"); // no ref in the task file and no origin/main in the synthetic repo
  assert.equal(saved.models.length, 3);
  assert.equal(saved.models[0].tasks.recon.runs.length, 2, "per-run rows are in the JSON");
  assert.ok(saved.finishedAt);
  assert.match(table, /fake-good \(baseline\) \| planted bug \| ✅ 2\/2/);
  assert.match(table, /fake-good \(baseline\) \| planted bug \(hard\) \| ✅ 2\/2/);
  assert.match(table, /fake-bad \| recon \| ❌ 0\/2 \| 1\/3/);
  assert.match(table, /fake-missing \| – \| 💥/);

  // A second run the same day doesn't overwrite the first.
  const again = await runBench({ tasksFile, ollamaUrl: url, outDir, models: ["fake-good"], tasks: ["recon"], runs: 1, env: noUserConfig(), log: () => {} });
  assert.notEqual(again.file, file);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(Object.keys(again.doc.models[0].tasks), ["recon"]);
});

test("--ctx sets num_ctx for the warm-up and the server; --runs 1 gives one run", async () => {
  chatCtx.length = 0;
  const r = await runBench({ tasksFile, ollamaUrl: url, outDir, models: ["fake-good"], tasks: ["recon"], runs: 1, ctx: 4096, env: noUserConfig(), log: () => {} });
  assert.equal(r.doc.numCtx, 4096);
  assert.equal(r.doc.ctxSource, "--ctx");
  assert.ok(chatCtx.length && chatCtx.every((c) => c === 4096), `chat num_ctx: ${chatCtx}`);
  assert.ok(generateCalls.some((c) => c.num_ctx === 4096));
  assert.equal(r.doc.models[0].tasks.recon.runs.length, 1);
  await assert.rejects(runBench({ tasksFile, ollamaUrl: url, outDir, models: ["fake-good"], runs: 0, log: () => {} }), /--runs must be/);
  await assert.rejects(runBench({ tasksFile, ollamaUrl: url, outDir, models: ["fake-good"], ctx: -5, log: () => {} }), /--ctx must be/);
  await assert.rejects(runBench({ tasksFile, ollamaUrl: url, outDir, models: ["fake-good"], tasks: ["nope"], log: () => {} }), /unknown task "nope" \(have: review, review_hard, recon\)/);
  await assert.rejects(runBench({ ollamaUrl: url, outDir, models: ["fake-good"], log: () => {} }), /--tasks-file is required/);
});

test("a malformed tool call that crew retries is counted in the run's retries", async () => {
  const r = await runBench({ tasksFile, ollamaUrl: url, outDir, models: ["fake-flaky"], tasks: ["recon"], runs: 2, env: noUserConfig(), log: () => {} });
  const t = r.doc.models[0].tasks.recon;
  assert.deepEqual(t.runs.map((x) => x.retries.malformed), [1, 0]);
  assert.equal(t.retries.malformed, 1);
  assert.equal(t.passes, 2, "the retried run still passed");
  assert.match(r.table, /malformed×1/);
});

test("a run whose answer crew had to reformat is recorded, counted, and shown in the Reformats column", async () => {
  const r = await runBench({ tasksFile, ollamaUrl: url, outDir, models: ["fake-prose"], tasks: ["recon"], runs: 2, env: noUserConfig(), log: () => {} });
  const t = r.doc.models[0].tasks.recon;
  assert.deepEqual(t.runs.map((x) => x.reformat), ["ok", null]);
  assert.deepEqual(t.reformats, { runs: 1, failed: 0, rejected: 0 });
  assert.equal(t.passes, 2, "the reformatted run still passed");
  const lines = r.table.split("\n");
  const col = lines[0].split(" | ").indexOf("Reformats");
  assert.equal(lines.find((l) => l.includes("fake-prose")).split(" | ")[col], "1");
});

test("a model named with different tag case resolves to the installed spelling", async () => {
  const r = await runBench({ tasksFile, ollamaUrl: url, outDir, models: ["Case-Model:q4_k_m"], tasks: ["recon"], runs: 1, env: noUserConfig(), log: () => {} });
  const m = r.doc.models[0];
  assert.equal(m.model, "Case-Model:q4_k_m", "reported as requested");
  assert.equal(m.resolvedModel, "Case-Model:Q4_K_M");
  assert.ok(chatModels.includes("Case-Model:Q4_K_M"), "the server was asked for the installed spelling");
  assert.ok(generateCalls.some((c) => c.model === "Case-Model:Q4_K_M"));
  assert.equal(m.tasks.recon.runs[0].ranModel, "Case-Model:Q4_K_M");
  assert.equal(m.tasks.recon.runs[0].reason.startsWith("ran on"), false);
});

function workerConfig() {
  const file = path.join(sandbox, "workers.json");
  fs.writeFileSync(file, JSON.stringify({
    workers: {
      llamacpp: { provider: "openai", label: "llama-server", baseUrl: `${url}/v1`, model: "qwen-llama", thinkingParam: "chat_template_kwargs" },
      deadw: { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "m" },
      ollamaw: { provider: "ollama", baseUrl: url, model: "fake-good" },
    },
  }));
  return { ...noUserConfig(), CREW_CONFIG: file };
}

test("--models can name an openai-provider worker: no Ollama load or ps, the worker's own config is used", async () => {
  openaiBodies.length = 0;
  const gen = generateCalls.length;
  const { doc, table } = await runBench({ tasksFile, ollamaUrl: url, outDir, baseline: null, models: ["llamacpp"], runs: 1, env: workerConfig(), log: () => {} });
  const m = doc.models[0];
  assert.equal(m.model, "llamacpp");
  assert.deepEqual(m.worker, { name: "llamacpp", provider: "openai", model: "qwen-llama", baseUrl: `${url}/v1`, thinkingParam: "chat_template_kwargs" });
  assert.equal(m.loadMs, undefined);
  for (const t of ["review", "review_hard", "recon"]) {
    const r = m.tasks[t].runs[0];
    assert.equal(r.pass, true, `${t}: ${r.reason}`);
    assert.equal(r.ranModel, "qwen-llama");
    assert.equal(r.ollama, null);
    assert.equal(r.tokens, 60, "two turns of 30 tokens");
  }
  assert.ok(openaiBodies.length >= 6 && openaiBodies.every((b) => b.model === "qwen-llama" && typeof b.chat_template_kwargs?.enable_thinking === "boolean"), "requests went to the worker with thinking control");
  assert.ok(!generateCalls.slice(gen).some((c) => c.model === "qwen-llama"), "nothing was loaded into Ollama for it");
  assert.equal(doc.numCtx, null);
  assert.match(doc.ctxSource, /n\/a/);
  assert.match(table, /llamacpp \| planted bug \| ✅ 1\/1/);
  assert.match(table, /llamacpp \| recon \| ✅ 1\/1 \| 3\/3 \|.*\| – \| – \|/, "no Ollama size or GPU for a worker");
});

test("worker names and Ollama tags mix; a worker that is down is an error row; other providers are refused", async () => {
  const env = workerConfig();
  const mixed = await runBench({ tasksFile, ollamaUrl: url, outDir, baseline: null, models: ["llamacpp", "fake-good", "deadw"], tasks: ["recon"], runs: 1, env, log: () => {} });
  assert.deepEqual(mixed.doc.models.map((m) => m.model), ["llamacpp", "fake-good", "deadw"]);
  assert.equal(mixed.doc.models[0].tasks.recon.passes, 1);
  assert.equal(mixed.doc.models[1].tasks.recon.passes, 1);
  assert.match(mixed.doc.models[2].error, /worker "deadw" not reachable at http:\/\/127\.0\.0\.1:1\/v1/);
  assert.equal(mixed.doc.numCtx, 65536, "the Ollama model still gets a context size");
  assert.equal(mixed.doc.ctxSource, "worker config");
  await assert.rejects(runBench({ tasksFile, ollamaUrl: url, outDir, baseline: null, models: ["ollamaw"], env, log: () => {} }), /"ollamaw" is a ollama worker.*pass its model tag \(fake-good\) instead/);
  await assert.rejects(runBench({ tasksFile, ollamaUrl: url, outDir, baseline: null, models: ["chatgpt"], env, log: () => {} }), /"chatgpt" is a codex-cli worker.*only openai-provider workers and Ollama tags/);
});

test("dry run builds the worktree, checks the tasks apply, removes it, runs no model", async () => {
  const n = chatModels.length;
  const r = await runBench({ tasksFile, ollamaUrl: url, outDir, models: ["fake-good"], dryRun: true, log: () => {} });
  assert.equal(r.file, null);
  assert.equal(chatModels.length, n);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
});

test("a remote repo.url is cloned into the cache once, its pinned ref fetched, and reused", async () => {
  const bare = path.join(sandbox, "remote.git");
  git(sandbox, "clone", "-q", "--bare", repo, bare);
  const sha = git(repo, "rev-parse", "HEAD");
  const remoteTasks = writeTaskFile(path.join(sandbox, "remote-tasks"), pathToFileURL(bare).href, sha);
  const cacheDir = path.join(sandbox, "cache");
  const logs = [];
  const r = await runBench({ tasksFile: remoteTasks, cacheDir, ollamaUrl: url, outDir, models: ["fake-good"], dryRun: true, log: (m) => logs.push(m) });
  assert.equal(r.doc.repo.sha, sha);
  assert.equal(r.doc.repo.ref, sha, "the task file's pinned ref");
  assert.ok(r.doc.repo.path.startsWith(cacheDir), r.doc.repo.path);
  assert.ok(logs.some((l) => l.startsWith(`cloning ${pathToFileURL(bare).href}`)));
  const logs2 = [];
  await runBench({ tasksFile: remoteTasks, cacheDir, ollamaUrl: url, outDir, models: ["fake-good"], dryRun: true, log: (m) => logs2.push(m) });
  assert.ok(!logs2.some((l) => l.startsWith("cloning")), "the cached clone is reused");
  // A pin to a commit the cached clone doesn't have yet (pushed after the clone) resolves on the next run.
  const scratch = path.join(sandbox, "pusher");
  git(sandbox, "clone", "-q", bare, scratch);
  git(scratch, "config", "user.email", "t@t"); git(scratch, "config", "user.name", "t");
  fs.writeFileSync(path.join(scratch, "newer.txt"), "x"); git(scratch, "add", "."); git(scratch, "commit", "-qm", "newer"); git(scratch, "push", "-q", "origin", "HEAD");
  const newer = git(scratch, "rev-parse", "HEAD");
  const newerTasks = writeTaskFile(path.join(sandbox, "remote-tasks-newer"), pathToFileURL(bare).href, newer);
  const n = await runBench({ tasksFile: newerTasks, cacheDir, ollamaUrl: url, outDir, models: ["fake-good"], dryRun: true, log: () => {} });
  assert.equal(n.doc.repo.sha, newer);
  // --repo still wins over the task file.
  const o = await runBench({ tasksFile: remoteTasks, repo, ollamaUrl: url, outDir, models: ["fake-good"], dryRun: true, log: () => {} });
  assert.equal(o.doc.repo.path, repo);
});

test("--check runs the task file's canned cases through the scorers; a wrong case fails with what differs", async () => {
  assert.deepEqual(await checkTaskFile(tasksFile), { file: tasksFile, total: 2, failures: [] });
  const dir = path.join(sandbox, "check-tasks");
  const f = writeTaskFile(dir, "../repo");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('claim: "a redelivered event throws" }], pass: true', 'claim: "a naming nit" }], pass: true'));
  const r = await checkTaskFile(f);
  assert.equal(r.failures.length, 1);
  assert.deepEqual([r.failures[0].task, r.failures[0].case], ["review", "dup"]);
  assert.match(r.failures[0].problem, /expected pass, got fail \(no quote-checked finding in webhook\.ts about duplicates\/redelivery\)/);
  // The CLI exits non-zero on a failing case, zero when all hold.
  const cli = (file) => {
    try { return { code: 0, out: execFileSync(process.execPath, [path.join(here, "..", "bench", "run.mjs"), "--tasks-file", file, "--check"], { encoding: "utf8" }) }; }
    catch (e) { return { code: e.status, out: e.stdout }; }
  };
  assert.deepEqual(cli(tasksFile), { code: 0, out: `2/2 canned cases hold in ${tasksFile}\n` });
  const bad = cli(f);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /^✗ review · dup: expected pass, got fail/m);
});

test("a task file is checked when loaded, naming the first problem", async () => {
  const dir = path.join(sandbox, "bad-tasks");
  const good = fs.readFileSync(writeTaskFile(dir, "../repo"), "utf8");
  const variant = async (name, edit) => {
    const f = path.join(dir, `${name}.mjs`);
    fs.writeFileSync(f, edit(good));
    return loadTaskFile(f);
  };
  await assert.rejects(loadTaskFile(path.join(dir, "missing.mjs")), /task file not found/);
  await assert.rejects(variant("nodefault", () => "export const x = 1;\n"), /no default export/);
  await assert.rejects(variant("nourl", (s) => s.replace(/url: "\.\.\/repo"/, 'url: ""')), /repo\.url is required/);
  await assert.rejects(variant("noplant", (s) => s.replace("plants/lock.diff", "plants/nope.diff")), /tasks\[1\] \("review_hard"\): plant not found/);
  await assert.rejects(variant("kind", (s) => s.replace('kind: "recon"', 'kind: "quiz"')), /tasks\[2\] \("recon"\): kind must be "review" or "recon"/);
  await assert.rejects(variant("dupid", (s) => s.replace('id: "review_hard"', 'id: "review"')), /tasks\[1\] \("review"\): duplicate id/);
  await assert.rejects(variant("nomatch", (s) => s.replace("match: (w) => /duplicate", "matcher: (w) => /duplicate")), /match\(words\) must be a function/);
  await assert.rejects(variant("noexpect", (s) => s.replace("expect: [", "expected: [")), /expect must be a non-empty array/);
  // A plant that doesn't touch its anchor is caught at preflight.
  const f = path.join(dir, "anchor.mjs");
  fs.writeFileSync(f, good.replace(`anchor: ${JSON.stringify(STOCK)}`, `anchor: ${JSON.stringify(TOTALS)}`));
  await assert.rejects(runBench({ tasksFile: f, ollamaUrl: url, outDir, models: ["fake-good"], dryRun: true, log: () => {} }), /task "review_hard": plant lock\.diff does not touch its anchor src\/shop\/totals\.ts/);
});

test("--ref makes the worktree from that ref, and the ref and sha are recorded", async () => {
  git(repo, "branch", "other");
  fs.writeFileSync(path.join(repo, "later.txt"), "later");
  git(repo, "add", "."); git(repo, "commit", "-qm", "later");
  const other = git(repo, "rev-parse", "other");
  assert.notEqual(other, git(repo, "rev-parse", "HEAD"));
  const logs = [];
  const r = await runBench({ tasksFile, ref: "other", ollamaUrl: url, outDir, models: ["fake-good"], dryRun: true, log: (m) => logs.push(m) });
  assert.deepEqual({ ref: r.doc.repo.ref, sha: r.doc.repo.sha }, { ref: "other", sha: other });
  assert.ok(logs.some((l) => l.includes(`@ other (${other.slice(0, 10)})`)));
  await assert.rejects(runBench({ tasksFile, ref: "no-such-ref", ollamaUrl: url, outDir, models: ["fake-good"], dryRun: true, log: () => {} }), /cannot resolve no-such-ref/);
});

test("a ref that lacks a recon task's expected file fails before any model runs", async () => {
  git(repo, "rm", "-q", TOTALS); git(repo, "commit", "-qm", "drop totals");
  const n = chatModels.length;
  await assert.rejects(runBench({ tasksFile, ollamaUrl: url, outDir, models: ["fake-good"], log: () => {} }), /task "recon": this ref lacks files the recon task expects: totals\.ts/);
  assert.equal(chatModels.length, n);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "worktree removed even on failure");
});

test("a ref where a plant no longer applies fails early, so a run never reviews a different bug", async () => {
  fs.writeFileSync(path.join(repo, STOCK), STOCK_SRC.replace("readStock(db, sku, { forUpdate: true })", "readStockLocked(db, sku)"));
  git(repo, "commit", "-qam", "refactor stock read");
  const n = chatModels.length;
  await assert.rejects(runBench({ tasksFile, ollamaUrl: url, outDir, models: ["fake-good"], tasks: ["review_hard"], log: () => {} }), /task "review_hard": plant lock\.diff does not apply at this ref: error: patch failed: src\/shop\/stock\.ts/);
  assert.equal(chatModels.length, n);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
});
