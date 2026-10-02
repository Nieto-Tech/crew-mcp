# crew-mcp

An MCP server that gives Claude Code a **crew**: a local GPU model and ChatGPT that
Claude can send out to map code, review its changes, and give second opinions.
Claude stays the lead. The crew does the grunt work and keeps it honest.

- **Local-first.** High-volume work (recon, diff review) runs on your GPU for free.
- **Falls back.** No GPU, or the model is down? The same tools use ChatGPT instead.
- **Checks, not vibes.** Findings must quote real code; Node verifies the quote
  exists before a finding counts. File:line references are checked mechanically.
- **Read-only.** Crew tools never write. Codex runs in its `read-only` sandbox.

## Why

One model reviewing its own work has the same blind spots as one developer reviewing
their own code. crew gives Claude a second and third pair of eyes:

- a **local model** that does the reading (mapping a flow, reviewing a diff) without
  spending your Claude context or subscription, and without sending code anywhere;
- a **different company's model** (ChatGPT) for independent second opinions on risky
  work, because different training means different blind spots;
- and **deterministic checks** that hold all of them to the actual code: a finding
  that can't quote a real line doesn't count.

## Tools

| Tool | What it does | Default worker |
|---|---|---|
| `crew_status` | Config, workspace, which workers are up, how roles resolve | none |
| `crew_recon` | Map the code for a question: files, functions, coverage per stage, evidence-checked risks | scout |
| `crew_review_diff` | Review working-tree changes; splits findings into evidence-checked vs unverified | scout |
| `crew_second_opinion` | Independent critique of a plan, design or diff, citations checked | reviewer |
| `crew_check_citations` | Deterministic `file:line` check, including "is that identifier really there?" | none (no model) |
| `crew_stats` | Per-worker calls, time, files/characters read, tokens generated, quote-checked vs unverified findings (`period`: today, week, all), plus a labeled estimate of context kept out of Claude | none |

**Roles** are fallback chains of **workers**:

- `scout`: recon and diff review. Put your local GPU first.
- `reviewer`: second opinions. Ideally a different strong model (ChatGPT).

**Worker providers:**

- `ollama`: any local model with tool calling.
- `codex-cli`: ChatGPT through the Codex CLI and your ChatGPT login. **No API key, no GPU.**
- `openai`: the OpenAI API, or any OpenAI-compatible server (LM Studio, llama.cpp's
  `llama-server`, vLLM). Local OpenAI-compatible servers are **EXPERIMENTAL**: tested against a fake OpenAI-compatible server in the test suite; not yet run against a real llama-server or vLLM.
  See [llama-server](#llama-server-llamacpp) below.

## Install

Requires Node 20+ and git.

```bash
git clone <this repo> crew-mcp && cd crew-mcp
npm install
npm test          # builds, then runs the end-to-end suite against fakes
```

For ChatGPT (recommended for everyone, required if you have no GPU):

```bash
npm i -g @openai/codex
codex login                      # sign in with your ChatGPT account
codex exec -s read-only "say hi" # sanity check
```

## Configure (per person)

Personal config lives in `~/.config/crew/config.json`, so the same install works
for everyone on a team. Copy the example that matches your machine:

```bash
mkdir -p ~/.config/crew
cp examples/config.large-gpu.json ~/.config/crew/config.json     # 24–32 GB GPU + ChatGPT
# or: examples/config.small-gpu.json     smaller GPU + ChatGPT fallback
# or: examples/config.chatgpt-only.json  no GPU, ChatGPT for everything
# or: examples/config.openai-compatible.json  LM Studio / OpenAI API (LM Studio: experimental)
# or: examples/config.llamacpp.json      llama-server on 127.0.0.1:8080 + ChatGPT fallback (experimental)
```

**Large GPU (24–32 GB):** the local model must exist in Ollama. Check with
`ollama list`, and see `ollama ps` for the context it actually loaded with. A dense
~27B model at Q4 with a 128K context fits a 32 GB card.

**Smaller GPU:** pick a model that supports tool calling and fits in VRAM. Keep
`numCtx` modest (16K on a 12 GB card is a sane start); read budgets scale down
automatically. Be aware that small, heavily quantized and mixture-of-experts models
are often fast but weak at the two things crew needs most: exploring several files
before answering, and quoting code exactly. If recon results are thin or findings
keep landing as *unverified*, flip the scout chain to `["chatgpt", "local"]`, or use
`config.chatgpt-only.json`.

**No usable GPU on your machine:** a worker can point at an Ollama server elsewhere
on your network. A private-address `baseUrl` still counts as local (see
[Repo policy](#repo-policy-crewjson)). Never expose Ollama to the internet; it has no
authentication.

Quick overrides without editing the file: `CREW_OLLAMA_MODEL`, `CREW_OLLAMA_URL`,
`CREW_NUM_CTX`, `CREW_SCOUT=local,chatgpt`, `CREW_REVIEWER=chatgpt`.

### llama-server (llama.cpp)

**EXPERIMENTAL:** tested against a fake OpenAI-compatible server in the test suite; not yet run against a real llama-server or vLLM. The same applies to the other local OpenAI-compatible
servers (vLLM, LM Studio).

`examples/config.llamacpp.json` is an `openai` worker at `http://127.0.0.1:8080/v1`. A
loopback or private `baseUrl` makes it **local** (usable in `cloud:false` repos), and crew
checks `GET /v1/models` so a stopped server falls through to the next worker in the chain.
Start the server with tool calling on, e.g. `llama-server -m model.gguf --jinja -c 65536`.

- `thinkingParam: "chat_template_kwargs"` sends `chat_template_kwargs.enable_thinking`:
  `false` on exploration turns (`thinkOnTools: true` to change that), and on the answer
  turn `true` unless `thinkOnFinal` is `false`. An empty or cut-off answer is retried once
  with `enable_thinking: false`, like the Ollama workers. The default, `"none"`, sends nothing.
- `model` is just the name sent in requests; llama-server serves whatever it was started with.
- Set `readBudgetChars` to at most about 1.8 × the server's `-c` (what Ollama workers get by
  default); the example uses 100000 for a 64K context. Without it an `openai` worker gets a
  200K-character budget, which can overflow a smaller context.

Never put API keys in the config. For the `openai` provider, `apiKeyEnv` names the
environment variable that holds the key.

## Register with Claude Code

```bash
claude mcp add --scope user crew -- node /absolute/path/to/crew-mcp/dist/index.js
claude mcp list
```

User scope makes the crew available in every project. The VS Code extension uses
Claude Code's configuration, so it picks this up too. Inside Claude Code, `/mcp`
shows whether the server connected.

Then ask Claude to run `crew_status`. It should show your workspace, a ✅ next to
each available worker, and which worker each role resolved to.

**Workspace:** tools read the directory Claude Code launched the server in. If
`crew_status` shows the wrong one, every tool accepts a `workspace` argument, or
set `CREW_WORKSPACE` in the server's environment.

**Long calls:** recon on a big repo can take a minute or two. If Claude Code times
out waiting on a tool, raise its MCP tool timeout (the `MCP_TOOL_TIMEOUT`
environment variable, in milliseconds, in recent versions).

**Permissions:** in auto mode, Claude Code's safety checks may stop to ask before
handing file contents to an MCP tool. The local-only tools (`crew_status`,
`crew_recon`, `crew_review_diff`, `crew_check_citations`, `crew_stats`) can be added to
your allow list under `/permissions`. `crew_second_opinion` sends content to ChatGPT;
decide for yourself whether it should ask first.

## Tell Claude when to use it

**Nothing to paste.** crew sends its usage guidance to Claude as MCP server
instructions when it connects: when to recon, when to review, what quote-checked
means, not to poll. It's versioned with the tools and only present when crew is.

To confirm it's working, ask Claude in a fresh session: *"What instructions did the
crew MCP server give you?"* It should describe the crew tools and when to use them.
If it can't, your client isn't surfacing server instructions; paste
`examples/CLAUDE.user.md` into your personal `~/.claude/CLAUDE.md` as a fallback.

**Making it reliable:** server instructions are guidance, and Claude may skip a crew call
on a task it judges small. If you want crew used every time, add a short, firm section to
your personal or repo `CLAUDE.md`, for example:

```markdown
## Crew
- Questions about how something works across more than two files: call `crew_recon`
  FIRST, before Grep/Read/Bash exploration. Then verify what your answer depends on.
- Before saying code changes are done: `crew_review_diff`.
- Auth, permissions, payments, migrations: `crew_second_opinion`.
```

A repo whose own agents or skills crew should fit around can say how, e.g. "run
`crew_recon`, then the repo's tracer agent". See `examples/repo-note.md`.

## Repo policy: `.crew.json`

Some repos must never send content to a cloud model, for example one holding regulated
data that your agreements with the cloud provider don't cover. Put a `.crew.json` at the
workspace root (commit it, so everyone gets the same rule):

```json
{ "cloud": false }
```

With `cloud: false`:

- Only **local** workers run: `ollama`, or `openai` whose `baseUrl` host is
  `localhost`, `127.0.0.1` or a private IP. `codex-cli` and remote `openai` are cloud.
  (An `ollama` worker pointed at a public host is treated as cloud too.)
- Cloud workers are skipped entirely, **with no fallback**. If no local worker is up,
  the tool fails with an error naming the policy. It never quietly uses ChatGPT.
- `crew_second_opinion` answers "disabled by repo policy (.crew.json)" without
  calling anything, unless a local worker is in the `reviewer` chain.
- `crew_status` shows the policy and which workers it excluded.
- A `.crew.json` that is present but unreadable (bad JSON, `"cloud": "false"`) **fails
  closed**: treated as `cloud: false`, and the status and errors say why.
- No file means no restriction.
- crew looks for `.crew.json` from the workspace up to the git root, so working in
  `repo/src` still finds `repo/.crew.json`. The strictest file wins; a nested
  `cloud: true` can't loosen a parent's `cloud: false`. A dangling symlink fails closed.
- Model requests refuse HTTP redirects, so a local endpoint can't bounce a prompt elsewhere.
- **What "local" means:** the worker's `baseUrl` host is loopback or a private address.
  crew trusts that endpoint. A LAN proxy that forwards to a cloud model would pass the
  check; only network egress rules can prevent that. Mapped loopback (`::ffff:127.0.0.1`)
  and `.local`/`.internal` hostnames are deliberately **not** recognized as local: they
  count as cloud, which fails closed. Use `localhost` or a literal IP.

Crew enforces this itself, whatever Claude asks for. `crew_check_citations` uses no model,
so it always works.

## Code maps

If a repo has `docs/CODEMAP.md` (or the file named by `"map"` in `.crew.json`), crew
includes it in the scout's prompt for `crew_recon` and `crew_review_diff` as "start here"
guidance, capped at about 8K characters. Keep it to one line per subsystem, listing entry
points with full paths from the repo root. Before sending it, crew checks that every path
in it exists, drops lines with stale paths, and reports them in the tool output and in
`crew_status`. A map outside the workspace is refused. In a small test, adding a code map
improved recon results on the same model and task.

## Diff size gate

`crew_review_diff` is for normal-sized changes. Before calling any model it measures the
diff against the scout's budget (60% of its read budget, at most 120K chars). If the diff
is bigger, it returns immediately, with no model call, saying so, with the changed files
grouped by directory with +/- counts. Re-run with `paths` on the riskiest ones. Pass
`force: true` to review anyway; the diff is then truncated, and a slow local model may
time out.

When a worker times out, the error names the worker and how long it ran, and says to
narrow with `paths` or raise `timeoutMs` for that worker in `~/.config/crew/config.json`.

## Reliability

- **Partial answers, not timeouts.** When about 65% of a worker's `timeoutMs` has gone,
  the scout's next turn is forced to be the final one (tools removed, "answer now with
  what you have"), the same as when the read budget runs out. The result is marked
  `partial: stopped exploring at Xs`. Only a hard failure of that final turn is an error.
- **Thinking is controlled** (Ollama; llama-server via `thinkingParam`). Exploration turns
  send `think: false` and `num_predict` 2048, because thinking there is mostly discarded
  tokens. The final answer turn allows thinking with `num_predict` 8192. Per worker:
  `thinkOnTools` (default false), `numPredictTools` (2048), `numPredictFinal` (8192),
  `thinkOnFinal` (default true). An answer cut off by the exploration cap is redone as the
  final turn; an empty or cut-off final answer is retried once without thinking.
- **One reformat turn.** If `crew_recon` or `crew_review_diff` gets a final answer that
  still isn't the JSON the tool needs (often a correct answer written as prose), the model
  gets one more turn: its own raw answer, the schema, and "Return only this content as JSON
  matching the schema; add nothing, drop nothing", with thinking off and an output cap sized
  to the answer. The result is marked `reformatted`. It may only restructure: if its JSON
  has a file path or an `evidence` quote that isn't in the raw answer, it is discarded
  (`reformat rejected: introduced <path>`) and the raw answer is shown instead. If it fails,
  the raw answer is returned as unstructured (`reformat failed`).
- **Malformed tool calls.** When Ollama can't parse the model's tool call (HTTP 500), the
  turn is redone with a nudge to use valid tool-call syntax, up to 2 times per task. A third
  malformed call fails the task.
- **One request at a time per local worker, across every session.** Each Claude Code session
  starts its own crew server, so crew queues through ticket files in
  `$XDG_STATE_HOME/crew/lanes/` (default `~/.local/state/crew/lanes/`): every crew process on
  the machine shares one queue per local server. Sessions take turns: a session's next call
  goes behind calls other sessions already have waiting. The timeout clock starts when the
  call gets the worker, not when it queued. Workers that share a server share a queue. A
  ticket whose process has exited, or whose heartbeat stopped for 30s, is cleared by the next
  process that looks, so a crashed session can't wedge the queue. While a call waits, it sends
  progress notes naming the call holding the worker (tool and repo directory name) and an
  estimated wait based on past call times in the usage log. `crew_status` shows the same.
  A call waits at most `queueWaitMs` (default 10 min, per worker), then fails with the same
  details.
- **Reviews go ahead of recons.** A recon is exploration and can usually wait; a diff review
  is what stands between Claude and "done". So every other call goes ahead of a waiting
  `crew_recon`, in the same session or another, until that recon has waited `reconYieldMs`
  (default 3 min, per worker); after that nothing passes it. A call that has started is never
  interrupted. The recon's progress notes say when later calls went ahead of it.
- **Long recons in the background.** A crew call blocks Claude's turn, queue time included.
  The usage guidance tells Claude to hand a recon it doesn't need right away to a background
  subagent and keep working. If the state directory can't be written, crew falls back to queueing within the
  session only.
- **Model names.** Ollama tags match case-insensitively (`Q4_K_M` vs `q4_K_M`); a model that
  isn't installed gets a list of the closest installed names.
- **Diagnostics.** Each turn logs to stderr: turn number, tool calls, prompt size, seconds
  and tokens generated. Timeouts and partial results carry a summary like
  `3 turns, 7 tool calls, 212s in model generation, 0s queued, 28,912 tokens generated`,
  so you can tell thinking from queueing from context growth.

## Usage stats

Every model call appends one metadata line to `~/.local/state/crew/usage.jsonl`
(`$XDG_STATE_HOME/crew/usage.jsonl`): time, tool, worker, provider, model, repo name, wall
seconds, turns, tool calls, files and characters read, tokens generated, outcome, and
quote-checked/unverified counts. No prompts, code or answers. `crew_stats` summarizes it;
`crew_status` shows a one-line `today:`. ChatGPT calls show calls and time only. The "context
kept out of Claude" figure is an estimate (characters read by local workers ÷ 4), not a
measurement. The log is never rotated; delete it any time.

The exception is the reformat turn. Each one appends a line to `reformats.jsonl` in the same
directory: the raw answer it was given, what it returned, the outcome and, if rejected, what
it introduced. It joins to the usage line on `ts` and `tool`, which carries only
`reformat: ok|failed|rejected`. That file holds answer text, which can quote your code, so it
is created owner-only (0600) and never leaves the machine. Delete it any time.

## What goes where

| Data | Local worker | ChatGPT (`codex-cli`) | Logs |
|---|---|---|---|
| Your code, diffs, questions | Stays on the machine (or your private network) | Sent to OpenAI under your ChatGPT account | Never in `usage.jsonl` |
| Findings and answers | Returned to Claude | Returned to Claude | Only reformat turns, in the owner-only `reformats.jsonl` |

If a repo can't send code to OpenAI, give it a `.crew.json` with `"cloud": false`.

## Sharing it

To hand it to someone without the source tree:

```bash
npm pack                                   # creates nieto-tech-crew-mcp-<version>.tgz
# on their machine:
npm i -g ./nieto-tech-crew-mcp-<version>.tgz
claude mcp add --scope user crew -- crew-mcp
```

## How the checks work

- **Quote gate.** Every diff-review finding and recon risk must include an exact
  quote. A finding counts as *quote-checked* only if that quote is found within 8
  lines of the cited line, or appears exactly once in the file and is long enough
  to be distinctive. A short, common quote like `throw err;` somewhere else in the
  file doesn't count. Everything else is *unverified* and shown as a hint.
  Quote-checked means the quoted code exists where claimed. **It doesn't mean the
  claim is right**, so Claude (and you) should still weigh the reasoning.
- **Citations.** `file:line` and `file:start-end` references are resolved (shortened
  paths, build/worktree copies ignored, ties broken by context and line range), and
  the lines must exist. When a backticked identifier sits right next to a citation,
  like `` `foo` (`file.ts:12`) ``, it must appear within 3 lines of the cited range.
- **Untracked files.** `crew_review_diff` includes new untracked files, but always
  skips AI-tool state (`.codex/`, `.claude/`, `.agents/`, `.cursor/`, …) and backups.
  Pass `includeUntracked: false` to review tracked changes only.
- **Budgets.** Local models get a read budget sized to their context window, so a
  long exploration can't overflow it. The final turn removes tools and forces an answer.

## Troubleshooting

- **`❌ local (ollama): model "…" not pulled`** in `crew_status`: run `ollama pull <model>`, or
  fix `model` in your config. The line lists the closest installed names.
- **`codex CLI not found`:** `npm i -g @openai/codex`, then `codex login`.
- **Recon comes back unstructured:** the model didn't return JSON, even after the reformat
  turn. The raw answer is shown. Usually this means the model is too small for the job; use
  ChatGPT as scout.
- **Findings keep landing as unverified:** the model is paraphrasing instead of quoting.
  Try a larger or less heavily quantized model, or ChatGPT as scout.
- **Server logs** go to stderr (stdout is the MCP protocol). Claude Code shows them
  under `/mcp`.

## Benchmark

`npm run bench` compares local models on known-answer crew tasks (planted bugs for
`crew_review_diff`, a question with a known answer for `crew_recon`) on your own hardware. It
drives the built server over MCP and prints pass rate, wall time, turns, tokens, retries and GPU
share per model and task. What it benchmarks comes from a **task file** you pass with
`--tasks-file`: a pinned repo, `.diff` plants, and scoring rules with canned cases that
`--check` verifies without a model. See [bench/README.md](bench/README.md).

## Roadmap

1. **Findings ledger:** known risks per file, so Claude sees them before editing.
2. **Nightly sweep:** re-verify open findings on the idle GPU.
3. **A public task file:** known-answer tasks against a pinned open-source repo, so anyone can
   compare local models for crew without writing their own.

## License

MIT. See [LICENSE](LICENSE).
