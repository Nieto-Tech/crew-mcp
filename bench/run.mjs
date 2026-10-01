#!/usr/bin/env node
// Benchmark engine: drive the built crew server over MCP, once per model, on the tasks a task file defines,
// against a throwaway git worktree of the repo that file names.
//
//   npm run bench -- --tasks-file path/to/tasks.mjs --models qwen3.6:35b,gemma4:31b
//   npm run bench -- --tasks-file path/to/tasks.mjs --check     # the file's canned cases; no repo, no model
//
// The worktree lives under the OS temp dir, is created fresh per run and removed after, so the source checkout
// is never touched (only its .git/worktrees bookkeeping, for the length of the run). See bench/README.md.
import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { anchorTest, checkCase, formatTable, parseOllamaPs, parseVia, scoreRecon, scoreReviewTask, summarize } from "./score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const serverJs = path.join(root, "dist", "index.js");

const CALL_TIMEOUT_MS = 15 * 60_000; // crew's own worker timeout (5 min by default) fires first
const CACHE_DIR = path.join(here, ".cache", "repos"); // clones of task files' remote repos (gitignored)

const git = (cwd, args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const tryGit = (cwd, args) => { try { return git(cwd, args); } catch { return null; } };
// Hooks off: a repo's post-checkout hook must not run because a benchmark made a worktree.
const NOHOOKS = ["-c", "core.hooksPath=/dev/null"];

/* ---------- worktree ---------- */

function addWorktree(repo, sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-bench-"));
  // autocrlf off: with Git for Windows' default (true) the checkout would be CRLF and LF .diff plants wouldn't apply.
  git(repo, [...NOHOOKS, "-c", "core.autocrlf=false", "worktree", "add", "--detach", dir, sha]);
  return dir;
}

function removeWorktree(repo, dir) {
  tryGit(repo, [...NOHOOKS, "worktree", "remove", "--force", dir]);
  tryGit(repo, ["worktree", "prune"]);
  fs.rmSync(dir, { recursive: true, force: true });
}

const assertClean = (wt) => {
  const s = git(wt, ["status", "--porcelain"]);
  if (s) throw new Error(`benchmark worktree is not clean:\n${s}`);
};

/**
 * Fail fast if this ref can't support the tasks, before any GPU time is spent: every review task's plant must
 * `git apply --check` cleanly (so a run never reviews a different bug than the one planted) and touch its anchor
 * file, and every recon task's expected files must be tracked. Returns one summary line per task.
 */
function preflight(wt, tasks) {
  const tracked = git(wt, ["ls-files"]).split("\n");
  const lines = [];
  for (const t of tasks) {
    if (t.kind === "review") {
      try {
        execFileSync("git", ["apply", "--check", t.plantPath], { cwd: wt, stdio: "pipe", encoding: "utf8" });
      } catch (e) {
        throw new Error(`task "${t.id}": plant ${path.basename(t.plantPath)} does not apply at this ref: ${String(e.stderr || e.message).trim()}`);
      }
      const touched = git(wt, ["apply", "--numstat", t.plantPath]).split("\n").filter(Boolean).map((l) => l.split("\t"));
      if (!touched.some(([, , f]) => anchorTest(t.anchor)(f)))
        throw new Error(`task "${t.id}": plant ${path.basename(t.plantPath)} does not touch its anchor ${t.anchor}`);
      const [add, del] = touched.reduce(([a, d], [x, y]) => [a + Number(x), d + Number(y)], [0, 0]);
      lines.push(`${t.id}: ${path.basename(t.plantPath)} applies (+${add} −${del} in ${touched.map(([, , f]) => f).join(", ")})`);
    } else {
      const missing = t.expect.filter((e) => !tracked.some(e.test)).map((e) => e.name);
      if (missing.length) throw new Error(`task "${t.id}": this ref lacks files the recon task expects: ${missing.join("; ")}`);
      lines.push(`${t.id}: all ${t.expect.length} expected files tracked`);
    }
  }
  return lines;
}

/* ---------- the task file ---------- */

const isRemote = (url) => /^(?:[a-z][\w+.-]*:\/\/|[\w.-]+@[\w.-]+:)/i.test(url);

/**
 * Load and check a task file: an ES module whose default export is { repo: { url, ref }, tasks: [...] }.
 * `repo.url` is a git URL (cloned into bench/.cache) or a path, relative to the task file; `repo.ref` should be a
 * pinned commit. Review tasks: { id, name?, kind: "review", plant: ".diff path relative to the file", anchor,
 * about, match(words), nearMiss?, cases? }. Recon tasks: { id, name?, kind: "recon", question,
 * expect: [{ name, test(path) }], cases? }. Throws naming the first problem.
 */
export async function loadTaskFile(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`task file not found: ${abs}`);
  const mod = await import(pathToFileURL(abs).href);
  const def = mod.default;
  const dir = path.dirname(abs);
  const bad = (m) => { throw new Error(`task file ${abs}: ${m}`); };
  if (!def || typeof def !== "object") bad("no default export");
  if (!def.repo?.url) bad("repo.url is required");
  if (!Array.isArray(def.tasks) || !def.tasks.length) bad("tasks must be a non-empty array");
  const ids = new Set();
  const tasks = def.tasks.map((t, i) => {
    const where = `tasks[${i}]${t?.id ? ` ("${t.id}")` : ""}`;
    if (!t?.id || !/^[\w-]+$/.test(t.id)) bad(`${where}: id must be a word ([A-Za-z0-9_-])`);
    if (ids.has(t.id)) bad(`${where}: duplicate id`);
    ids.add(t.id);
    const out = { ...t, name: t.name || t.id, cases: t.cases || [] };
    if (t.kind === "review") {
      if (typeof t.plant !== "string") bad(`${where}: plant (a .diff path) is required`);
      out.plantPath = path.resolve(dir, t.plant);
      if (!fs.existsSync(out.plantPath)) bad(`${where}: plant not found: ${out.plantPath}`);
      if (!t.anchor) bad(`${where}: anchor (the file a finding must be in) is required`);
      if (typeof t.match !== "function") bad(`${where}: match(words) must be a function`);
      if (t.nearMiss && (typeof t.nearMiss.test !== "function" || !t.nearMiss.reason)) bad(`${where}: nearMiss needs test(words) and reason`);
      out.about ||= "the planted bug";
    } else if (t.kind === "recon") {
      if (!t.question) bad(`${where}: question is required`);
      if (!Array.isArray(t.expect) || !t.expect.length || t.expect.some((e) => !e?.name || typeof e.test !== "function"))
        bad(`${where}: expect must be a non-empty array of { name, test(path) }`);
    } else bad(`${where}: kind must be "review" or "recon"`);
    return out;
  });
  const url = String(def.repo.url);
  return { file: abs, repo: { url, ref: def.repo.ref || null, path: isRemote(url) ? null : path.resolve(dir, url) }, tasks };
}

/** The git checkout to make worktrees from: --repo, else the task file's path, else a cached clone of its URL. */
function resolveRepoDir(tf, override, log, cacheDir = CACHE_DIR) {
  if (override) return path.resolve(override);
  if (tf.repo.path) {
    if (!tryGit(tf.repo.path, ["rev-parse", "--git-dir"])) throw new Error(`repo ${tf.repo.path} (from ${tf.file}) is not a git checkout`);
    return tf.repo.path;
  }
  const dir = path.join(cacheDir, tf.repo.url.replace(/^[a-z+]+:\/\/|\.git$/gi, "").replace(/[^\w.-]+/g, "_"));
  if (!fs.existsSync(path.join(dir, ".git")) && !fs.existsSync(path.join(dir, "HEAD"))) {
    log(`cloning ${tf.repo.url} into ${dir}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(path.dirname(dir), [...NOHOOKS, "clone", "--quiet", "--no-checkout", tf.repo.url, dir]);
  }
  return dir;
}

/**
 * Resolve the ref to a commit. In a cached clone that doesn't have it yet, fetch every branch and tag first (a pin
 * to a newer commit on any branch then resolves on any host), and only then ask for the ref itself, which some
 * hosts refuse for a bare SHA.
 */
function resolveSha(repoDir, ref, cached) {
  const verify = (r) => tryGit(repoDir, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]);
  let sha = verify(ref);
  if (sha || !cached) return sha;
  tryGit(repoDir, ["fetch", "--quiet", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  sha = verify(ref);
  if (!sha && tryGit(repoDir, ["fetch", "--quiet", "origin", ref]) !== null) sha = verify("FETCH_HEAD");
  return sha;
}

/**
 * Run a task file's canned cases through the real scorers: no repo, no model. Returns { total, failures: [{ task,
 * case, problem }] }.
 */
export async function checkTaskFile(file) {
  const tf = await loadTaskFile(file);
  const failures = [];
  let total = 0;
  for (const t of tf.tasks) {
    for (const [i, c] of t.cases.entries()) {
      total++;
      const problem = checkCase(t, c);
      if (problem) failures.push({ task: t.id, case: c.name || `#${i + 1}`, problem });
    }
  }
  return { file: tf.file, total, failures };
}

/* ---------- ollama ---------- */

async function ollama(url, p, body) {
  const res = await fetch(`${url}${p}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ollama ${p} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const loaded = async (url) => (await ollama(url, "/api/ps")).models || [];
const unload = (url, model) => ollama(url, "/api/generate", { model, keep_alive: 0 }).catch(() => {});
async function unloadAll(url) {
  for (const m of await loaded(url).catch(() => [])) await unload(url, m.model || m.name);
}

/** Crew's configured workers (config files + env), as the server will see them. */
async function configuredWorkers(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const { loadConfig } = await import(pathToFileURL(path.join(root, "dist", "config.js")).href);
    return loadConfig().config.workers;
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** The context window crew's local Ollama worker is configured with. 32768 is crew's own fallback when numCtx is unset. */
const configuredCtx = async (env) => (await configuredWorkers(env)).local?.numCtx || 32768;

/**
 * What each --models entry means: a configured openai-provider worker (llama-server, LM Studio, ...) by name,
 * else an Ollama tag. Naming a worker of another provider is an error, not a silent tag lookup.
 */
function resolveTargets(names, workers) {
  return names.map((name) => {
    const w = workers[name];
    if (!w) return { kind: "ollama", name };
    if (w.provider === "openai") return { kind: "worker", name, worker: w };
    throw new Error(
      `--models "${name}" is a ${w.provider} worker in your crew config; ` +
        (w.provider === "ollama" ? `pass its model tag${w.model ? ` (${w.model})` : ""} instead` : "only openai-provider workers and Ollama tags can be benchmarked")
    );
  });
}

/* ---------- tasks ---------- */

/** How one task file entry runs: review tasks plant their .diff, review, and always restore the worktree. */
function runnable(t) {
  if (t.kind === "recon") {
    return { tool: "crew_recon", args: (wt) => ({ question: t.question, workspace: wt }), score: (text) => scoreRecon(text, t.expect) };
  }
  return {
    tool: "crew_review_diff",
    args: (wt) => ({ workspace: wt }), // deliberately no `focus`: that would hand over the answer
    prepare(wt) {
      execFileSync("git", ["apply", t.plantPath], { cwd: wt, stdio: "pipe" });
    },
    restore(wt) {
      git(wt, ["checkout", "--", "."]);
      git(wt, ["clean", "-fdq"]); // a plant may add files
      assertClean(wt);
    },
    score: (text) => scoreReviewTask(t, text),
  };
}

/** One task call: prepare the tree, call the tool, score, always restore. Never throws; errors become a failed record. */
async function runOnce({ client, task, wt, model, ps, o, stderrLog }) {
  const rec = {};
  try {
    assertClean(wt);
    task.prepare?.(wt);
    const mark = stderrLog().length;
    const t1 = Date.now();
    const res = await client.callTool({ name: task.tool, arguments: task.args(wt) }, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    rec.wallMs = Date.now() - t1;
    const text = res.content?.[0]?.text ?? "";
    const via = parseVia(text);
    Object.assign(rec, task.score(text), {
      turns: via.turns, toolCalls: via.toolCalls, tokens: via.tokens, filesRead: via.filesRead,
      serverSeconds: via.seconds, queuedSeconds: via.queuedSeconds, partial: via.partial,
      retries: {
        malformed: via.malformedRetries,
        final: via.finalRetry,
        explorationRedos: (stderrLog().slice(mark).match(/redoing as final turn/g) || []).length,
      },
      reformat: via.reformat,
      ranModel: via.model,
    });
    if (via.model && model && via.model !== model) {
      rec.pass = false;
      rec.reason = `ran on ${via.model}, not ${model}`;
    }
    rec.ollama = ps ? parseOllamaPs({ models: await loaded(o.ollamaUrl) }, model) : null;
    rec.output = text;
  } catch (e) {
    rec.error = e.message;
    rec.pass = false;
    rec.reason = e.message.slice(0, 160);
  } finally {
    task.restore?.(wt);
  }
  return rec;
}

/* ---------- one model ---------- */

async function benchModel({ target, wt, o, log }) {
  const out = { model: target.name, tasks: {} };
  if (o.unload) await unloadAll(o.ollamaUrl); // frees VRAM for a llama-server worker too

  let model; // what the server should report running: the installed Ollama name, or the worker's configured model
  let serverEnv;
  if (target.kind === "worker") {
    const w = target.worker;
    const base = (w.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    out.worker = { name: target.name, provider: w.provider, model: w.model ?? null, baseUrl: base, thinkingParam: w.thinkingParam ?? "none" };
    try {
      await fetch(`${base}/models`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    } catch (e) {
      out.error = `worker "${target.name}" not reachable at ${base} (${e.cause?.code || e.message})`;
      return out;
    }
    model = w.model;
    serverEnv = { CREW_SCOUT: target.name }; // the worker's own config applies: model, baseUrl, thinkingParam, budgets
    log(`${target.name}: worker ${w.provider} @ ${base}${w.model ? ` (${w.model})` : ""}`);
  } else {
    const requested = target.name;
    // Match against what is installed: the tag is case-insensitive, and a miss lists the nearest names.
    const { findModel, closestModels } = await import(pathToFileURL(path.join(root, "dist", "models.js")).href);
    let installed;
    try {
      installed = ((await ollama(o.ollamaUrl, "/api/tags")).models || []).map((m) => m.name);
    } catch (e) {
      out.error = `could not list installed models: ${e.message}`;
      return out;
    }
    model = findModel(installed, requested);
    if (!model) {
      out.error = `model not installed (${installed.length ? `closest installed: ${closestModels(installed, requested).join(", ")}` : "no models installed"})`;
      return out;
    }
    if (model !== requested) { out.resolvedModel = model; log(`${requested}: using installed name ${model}`); }

    // Load the model at the benchmark's context size first, so task wall times exclude the cold load.
    const t0 = Date.now();
    try {
      await ollama(o.ollamaUrl, "/api/generate", { model, prompt: "", keep_alive: "1h", options: { num_ctx: o.ctx } });
    } catch (e) {
      out.error = `could not load model: ${e.message}`;
      return out;
    }
    out.loadMs = Date.now() - t0;
    log(`${requested}: loaded in ${(out.loadMs / 1000).toFixed(1)}s`);
    serverEnv = {
      CREW_OLLAMA_MODEL: model,
      CREW_OLLAMA_URL: o.ollamaUrl,
      CREW_NUM_CTX: String(o.ctx),
      CREW_SCOUT: "local", // no ChatGPT fallback: a fallback would be scored as this model
    };
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: {
      ...process.env,
      ...serverEnv,
      CREW_WORKSPACE: wt,
      XDG_STATE_HOME: path.join(os.tmpdir(), "crew-bench-state"), // bench calls are not real usage
      ...o.env,
    },
    stderr: "pipe",
  });
  let stderrLog = "";
  transport.stderr?.on("data", (c) => { stderrLog += c; });
  const client = new Client({ name: "crew-bench", version: "0" });

  try {
    await client.connect(transport);
    for (const name of o.tasks) {
      const task = o.runnables[name];
      const runs = [];
      for (let i = 1; i <= o.runs; i++) {
        const rec = await runOnce({ client, task, wt, model, ps: target.kind === "ollama", o, stderrLog: () => stderrLog });
        rec.run = i;
        runs.push(rec);
        log(`${target.name} · ${name} [${i}/${o.runs}]: ${rec.error ? "ERROR " + rec.reason : (rec.pass ? "pass" : "FAIL") + ` (${rec.reason}) in ${(rec.wallMs / 1000).toFixed(1)}s`}`);
      }
      out.tasks[name] = { ...summarize(runs), runs };
    }
  } finally {
    await client.close().catch(() => {});
    if (o.unload && target.kind === "ollama") await unload(o.ollamaUrl, model);
  }
  return out;
}

/* ---------- the run ---------- */

export async function runBench(opts) {
  const o = {
    tasksFile: null, cacheDir: undefined, models: [], baseline: null, repo: null, ref: null, ollamaUrl: "http://localhost:11434",
    ctx: undefined, runs: 3, tasks: null, outDir: path.join(here, "results"), unload: true,
    dryRun: false, env: {}, log: (m) => console.error(`[bench] ${m}`),
    ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
  };
  if (!o.tasksFile) throw new Error("--tasks-file is required: an ES module with { repo: { url, ref }, tasks } (see bench/README.md)");
  const tf = await loadTaskFile(o.tasksFile);
  o.tasks ||= tf.tasks.map((t) => t.id);
  const byId = Object.fromEntries(tf.tasks.map((t) => [t.id, t]));
  o.ollamaUrl = o.ollamaUrl.replace(/\/$/, "");
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error(`--runs must be a whole number >= 1 (got ${o.runs})`);
  if (o.ctx !== undefined && (!Number.isInteger(o.ctx) || o.ctx < 1)) throw new Error(`--ctx must be a whole number >= 1 (got ${o.ctx})`);
  const order = [...(o.baseline ? [o.baseline] : []), ...o.models.filter((m) => m !== o.baseline)];
  const targets = resolveTargets(order, await configuredWorkers(o.env));
  // num_ctx is an Ollama setting; a llama-server worker has whatever context the server was started with.
  const usesOllama = targets.some((t) => t.kind === "ollama");
  const ctxSource = !usesOllama ? "n/a: servers set their own" : o.ctx ? "--ctx" : "worker config";
  if (usesOllama) o.ctx ||= await configuredCtx(o.env);
  else o.ctx = null;
  const log = o.log;
  for (const t of o.tasks) if (!byId[t]) throw new Error(`unknown task "${t}" (have: ${Object.keys(byId).join(", ")})`);
  const selected = o.tasks.map((id) => byId[id]);
  o.runnables = Object.fromEntries(selected.map((t) => [t.id, runnable(t)]));
  if (!fs.existsSync(serverJs)) throw new Error("dist/index.js is missing: run `npm run build` first");

  const repoDir = resolveRepoDir(tf, o.repo, log, o.cacheDir);
  const cached = !o.repo && !tf.repo.path;
  const ref = o.ref || tf.repo.ref || (tryGit(repoDir, ["rev-parse", "--verify", "origin/main^{commit}"]) ? "origin/main" : "HEAD");
  const sha = resolveSha(repoDir, ref, cached);
  if (!sha) throw new Error(`cannot resolve ${ref} in ${repoDir}`);

  const doc = {
    date: new Date().toISOString().slice(0, 10),
    startedAt: new Date().toISOString(),
    crewVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
    tasksFile: tf.file,
    repo: { url: tf.repo.url, path: repoDir, ref, sha },
    numCtx: o.ctx,
    ctxSource,
    runs: o.runs,
    tasks: o.tasks,
    taskNames: selected.map((t) => [t.id, t.name]),
    baseline: o.baseline,
    models: [],
  };

  const wt = addWorktree(repoDir, sha);
  let cleaned = false;
  const cleanup = () => { if (!cleaned) { cleaned = true; removeWorktree(repoDir, wt); log(`removed worktree ${wt}`); } };
  const onSignal = (sig) => () => { cleanup(); process.exit(sig === "SIGINT" ? 130 : 143); };
  const handlers = ["SIGINT", "SIGTERM"].map((s) => [s, onSignal(s)]);
  for (const [s, h] of handlers) process.once(s, h);

  let file = null;
  try {
    log(`worktree ${wt} @ ${ref} (${sha.slice(0, 10)})`);
    for (const line of preflight(wt, selected)) log(`preflight ok: ${line}`);
    if (o.dryRun) return { doc, file, table: "" };

    fs.mkdirSync(o.outDir, { recursive: true });
    file = path.join(o.outDir, `${doc.date}.json`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(o.outDir, `${doc.date}-${n}.json`);

    for (const target of targets) {
      log(`=== ${target.name}${target.name === o.baseline ? " (baseline)" : ""}${target.kind === "worker" ? " (worker)" : ""} ===`);
      const r = await benchModel({ target, wt, o, log });
      if (target.name === o.baseline) r.baseline = true;
      doc.models.push(r);
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n"); // after every model: a crash keeps what finished
    }
    doc.finishedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    return { doc, file, table: formatTable(doc) };
  } finally {
    for (const [s, h] of handlers) process.off(s, h);
    cleanup();
  }
}

/* ---------- CLI ---------- */

async function main() {
  const { values: v } = parseArgs({
    options: {
      "tasks-file": { type: "string" },
      check: { type: "boolean" },
      models: { type: "string" },
      baseline: { type: "string" },
      "no-baseline": { type: "boolean" },
      repo: { type: "string" },
      ref: { type: "string" },
      "ollama-url": { type: "string" },
      ctx: { type: "string" },
      runs: { type: "string" },
      tasks: { type: "string" },
      "out-dir": { type: "string" },
      config: { type: "string" },
      "no-unload": { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (v.help) {
    console.log(`npm run bench -- --tasks-file FILE --models a,b,c [options]
npm run bench -- --tasks-file FILE --check

  --tasks-file    ES module: { repo: { url, ref }, tasks } (see bench/README.md). Required.
  --check         run the task file's canned cases through the scorers and exit; no repo, no model

  --models        comma-separated: Ollama tags, or names of openai-provider workers from your crew config
                  (e.g. a llama-server worker; see examples/config.llamacpp.json)
  --config        crew config file that defines those workers (same as setting CREW_CONFIG)
  --baseline      baseline model, always run first (default: the model crew is configured with now)
  --no-baseline   don't add a baseline
  --repo          git checkout to make the worktree from (default: the task file's repo.url, cloned into bench/.cache if remote)
  --ref           git ref to make the worktree from (default: the task file's repo.ref, else origin/main, else HEAD)
  --ollama-url    default $CREW_OLLAMA_URL or http://localhost:11434
  --runs          runs of each task per model (default 3); the table shows pass rate and medians
  --ctx           num_ctx for every model (default: the local worker's configured numCtx)
  --tasks         comma-separated task ids from the task file (default: all, in file order)
  --out-dir       default bench/results
  --no-unload     don't unload other models before each run (GPU% then depends on what else is loaded)
  --dry-run       make the worktree, check the tasks apply, remove it; no models are run`);
    return;
  }
  if (v.check) {
    if (!v["tasks-file"]) throw new Error("--check needs --tasks-file");
    const r = await checkTaskFile(v["tasks-file"]);
    for (const f of r.failures) console.log(`✗ ${f.task} · ${f.case}: ${f.problem}`);
    console.log(`${r.total - r.failures.length}/${r.total} canned cases hold in ${r.file}`);
    if (r.failures.length || !r.total) process.exitCode = 1;
    return;
  }
  if (v.config) process.env.CREW_CONFIG = path.resolve(v.config);
  let baseline = null;
  if (!v["no-baseline"]) {
    baseline = v.baseline || null;
    if (!baseline) {
      try { baseline = (await import(pathToFileURL(path.join(root, "dist", "config.js")).href)).loadConfig().config.workers.local?.model || null; } catch {}
      baseline ||= "qwen3.8:27b";
    }
  }
  const models = (v.models || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!models.length && !baseline && !v["dry-run"]) throw new Error("give --models a,b,c");

  const { doc, file, table } = await runBench({
    tasksFile: v["tasks-file"],
    models, baseline,
    repo: v.repo, ref: v.ref,
    ollamaUrl: v["ollama-url"] || process.env.CREW_OLLAMA_URL || "http://localhost:11434",
    ctx: v.ctx ? Number(v.ctx) : undefined,
    runs: v.runs ? Number(v.runs) : undefined,
    tasks: v.tasks ? v.tasks.split(",").map((s) => s.trim()) : undefined,
    outDir: v["out-dir"],
    unload: !v["no-unload"],
    dryRun: !!v["dry-run"],
  });
  if (v["dry-run"]) { console.log("dry run ok"); return; }
  console.log(`\ncrew ${doc.crewVersion} · ${doc.repo.ref} @ ${doc.repo.sha.slice(0, 10)} · num_ctx ${doc.numCtx ?? "n/a"} (${doc.ctxSource}) · ${doc.runs} run${doc.runs === 1 ? "" : "s"} per task\n`);
  console.log(table);
  console.log(`\nResults: ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[bench] ${e.message}`); process.exit(1); });
}
