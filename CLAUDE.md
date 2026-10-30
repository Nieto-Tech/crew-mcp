# CLAUDE.md: Nieto Crew (`Nieto-Tech/crew-mcp`)

An MCP server that gives Claude Code read-only helpers: a local model (Ollama or a local
OpenAI-compatible server) and ChatGPT via the Codex CLI, behind the `crew_*` tools. What it does
and how it is configured is in `README.md`; what a PR needs is in `CONTRIBUTING.md`. This file
covers what neither says plainly.

## Names: two generations, on purpose

| Thing | Name |
|---|---|
| Product | Nieto Crew |
| npm package | `@nieto-tech/nieto-crew` |
| Command (`bin`) | `nieto-crew` |
| MCP server name (reported and documented) | `nieto-crew` |
| GitHub repo | `Nieto-Tech/crew-mcp` (not renamed yet) |
| Tools | `crew_recon`, `crew_review_diff`, … |
| Config / state | `~/.config/crew/`, `~/.local/state/crew/`, `CREW_*` env vars, `.crew.json` |

Don't rename the last two rows. The tool names are what users' CLAUDE.md files and permission
rules refer to. The state directory holds the cross-process GPU queue
(`~/.local/state/crew/lanes/`), so sessions on an old build and a new one must agree on where it
is. `nieto-crew` exists because the unrelated `crew-mcp` package on npm registers itself as
`crew` and would replace a server of that name.

## Commands

- `npm test`: builds with `tsc`, then runs every `test/*.test.mjs` against fakes, offline. It
  takes a few minutes; run it in the background.
- One area: `npm run build && node --test --test-name-pattern="<regex>" test/e2e.test.mjs`.
- `npm run bench` needs a real local model; it is optional.

## Where things are

- `src/index.ts`: the MCP tools, their output (the `_via …_` line), `VERSION`.
- `src/workers.ts`: picking a worker for a role (`resolveRole`), the queue, one attempt
  (`runOn`), falling through the chain when a worker goes away (`runTask`).
- `src/agent.ts`: the Ollama and OpenAI-compatible providers and the tool loop (`runAgent`):
  retries for malformed tool calls, empty or cut-off answers, lost connections, the reformat turn.
- `src/lane.ts`: the queue shared by every crew process on the machine (ticket files).
- `src/policy.ts`: `.crew.json` (`cloud:false`). `src/checks.ts`: the quote gate and citation checks.
- `src/instructions.ts`: the guidance sent to Claude on connect. It is the single source for
  "when to use crew"; `examples/CLAUDE.user.md` is only a fallback copy.

## Rules that aren't obvious from the code

- **The guarantees.** Crew never writes to the repo; `cloud:false` never reaches a cloud worker,
  not even as a fallback; a finding is quote-checked only if its quote is really there. A change
  near any of these needs tests for the failure cases, not just the happy path.
- **A bug fix comes with a test that fails without it.** Most behaviour is tested end to end in
  `test/e2e.test.mjs` against a fake Ollama that is scripted by model name. Tests that need
  their own server, such as one that drops connections, start one per test (see `flakyOllama`).
  Tests set `XDG_STATE_HOME` to a temp directory so they never touch real state.
- **User-visible changes** update `README.md` and add a line under `[Unreleased]` in
  `CHANGELOG.md`.
- **Fixtures are synthetic.** No code, paths or names from a real private project.
- **The version lives in two places:** `package.json` and `VERSION` in `src/index.ts`. A test
  fails if they differ.

## Branches and releases

- `main` only. Work on a branch, open a PR, squash-merge. Never push to `main`.
- Releasing is in `CONTRIBUTING.md`: a version PR, then `gh release create vX.Y.Z`. That
  triggers `.github/workflows/publish.yml`, which waits for the `npm` environment's reviewer.
  Never run `npm publish` by hand. A manual run of the workflow is always a dry run.
- Publishing uses npm trusted publishing (OIDC): no npm token or secret exists. Both the
  trusted-publisher entry and "disallow tokens" are package settings on npmjs.com, not in this
  repo. `repository.url` in `package.json` must match the GitHub repo for that to work, so
  renaming the repo means updating both.

## Working on crew with crew

If your Claude Code runs crew from this checkout (`node …/dist/index.js`), building here changes
the server that **new** sessions start. Sessions already running keep the code they started
with until they reconnect (`/mcp`). A broken build in `dist/` breaks crew for every new session,
so don't leave one there. Running `crew_review_diff` on this repo's own changes works and is
expected.
