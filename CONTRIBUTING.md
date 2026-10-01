# Contributing

Thanks for helping. crew is small on purpose: a few tools, mechanical checks, and clear rules
about where code goes. Changes that keep it that way are the easiest to merge.

## Setup

Requires Node 20+ and git. No GPU or ChatGPT account is needed to develop or test.

```bash
git clone https://github.com/Nieto-Tech/crew-mcp.git && cd crew-mcp
npm install
npm test
```

`npm test` builds (`tsc`) and runs every suite in `test/` against fakes: a fake Ollama, a fake
OpenAI-compatible server and a fake Codex CLI, over the real MCP protocol. It should pass offline.

To try a change in Claude Code, point it at your build:
`claude mcp add --scope user crew -- node /absolute/path/to/crew-mcp/dist/index.js`, then run
`crew_status`.

The benchmark (`npm run bench`, see `bench/README.md`) needs a local model and is optional.

## What a pull request needs

- **A test for the behaviour it changes.** Bugs get a test that fails without the fix. Most
  behaviour is tested end to end in `test/e2e.test.mjs` with a scripted fake model; follow the
  patterns there.
- **`npm test` green** on Node 20 and 22. CI runs it on Ubuntu and Windows.
- **Docs that match.** If users can see the change (a tool, an option, a default, an output
  line), update `README.md`, and add a line under `[Unreleased]` in `CHANGELOG.md`.
- **Synthetic fixtures only.** Tests and examples must not contain code, paths, names or data
  from a real private project.
- **The guarantees intact.** Crew tools stay read-only; `cloud: false` never falls back to a
  cloud worker; a finding counts as quote-checked only when its quote is really there. A change
  that touches the policy, the quote gate or the citation checks needs tests for the failure
  cases, not just the happy path. Security issues go through `SECURITY.md`, not a PR.
- **One change per PR**, with a description of what changed and why. Commit messages: imperative
  mood, say why.

Small fixes (typos, a clearer error message) are welcome without an issue first. For anything
bigger, open an issue so we can agree on the approach before you spend time on it.

By contributing you agree that your contribution is licensed under the MIT license (`LICENSE`).
