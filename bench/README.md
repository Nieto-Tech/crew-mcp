# crew benchmark

Compare local models (and OpenAI-compatible workers) on known-answer crew tasks, on your own
hardware. The engine here drives the built crew server over MCP, exactly as Claude Code would;
**what** to benchmark comes from a task file.

```bash
npm run bench -- --tasks-file path/to/tasks.mjs --models qwen3.8:27b,gemma4:31b --runs 3
npm run bench -- --tasks-file path/to/tasks.mjs --check      # canned cases only: no repo, no model
npm run bench -- --tasks-file path/to/tasks.mjs --dry-run    # make the worktree, check every plant applies
npm run bench -- --help
```

Each run makes a throwaway git worktree of the task file's repo at its pinned commit (under the
OS temp dir), plants each review task's bug, calls `crew_review_diff` or `crew_recon`, scores the
answer, and restores the tree. Results go to `bench/results/<date>.json` and a table is printed:
pass rate, median wall time, turns, tool calls, tokens, retries, reformats, quote-checked vs
unverified, and the model's size and GPU share from `ollama ps`.

## Task files

A task file is an ES module whose default export is:

```js
export default {
  // A git URL (cloned once into bench/.cache) or a path relative to this file. Pin a commit.
  repo: { url: "https://github.com/owner/project.git", ref: "<40-char sha>" },
  tasks: [
    {
      id: "dedupe",                 // [A-Za-z0-9_-], used by --tasks and in results
      name: "planted bug",          // shown in the table
      kind: "review",
      plant: "plants/dedupe.diff",  // unified diff, relative to this file; applied with `git apply`
      anchor: "src/payments/webhook.ts", // a finding must be in this file (matched by file name), or a RegExp
      about: "duplicates/redelivery",    // used in the fail reason
      match: (words) => /duplicate|re-?deliver/i.exec(words)?.[0] ?? null,
      nearMiss: { test: (words) => /\bguard\b/i.test(words), reason: "names the guard, not what it prevented" }, // optional
      cases: [/* canned answers, see below */],
    },
    {
      id: "recon",
      kind: "recon",
      question: "how does a payment webhook become a payments row, including idempotency guards",
      expect: [{ name: "webhook.ts", test: (path) => /(^|\/)webhook\.ts$/.test(path) }],
      cases: [],
    },
  ],
};
```

**Review tasks** pass when a *quote-checked* finding in the `anchor` file has words (its claim and
fix, never the quoted code) for which `match` returns non-null. A finding the quote check could not
confirm doesn't count. Write `match` so that restating the diff isn't enough: if the plant removes a
lock, naming "the lock" proves nothing, because the diff shows it; require what the lock prevented.
Use `nearMiss` to get a distinct fail reason for those answers.

**Plants** are checked before any model runs: each must `git apply --check` cleanly at the ref and
touch its anchor. If the code has moved, the run stops rather than reviewing a different bug.
Make one by editing the file in a checkout at the pinned commit and saving `git diff -- <file>`.

**Recon tasks** pass when every `expect` entry matches a path in the answer's Files section; the
table's Score column shows how many were found. Every expected file must be tracked at the ref.

**Cases** are canned crew answers that `--check` runs through the real scorers, so a task file's
scoring rules are tested without a model:

```js
{ name: "lock token only", checked: [{ file: "src/stock.ts", claim: "forUpdate was dropped" }], pass: false, reason: /names the removed lock/ }
{ name: "unstructured", output: "Scout did not return structured output. ...", pass: false }
{ name: "all files", files: ["src/webhook.ts", "db/migrations/001_payments.sql"], pass: true } // recon
```

A review case lists findings (`{ file, claim, evidence?, fix?, severity? }`) under `checked`
(quote-checked) and `unverified`, or gives a raw `output`. `--check` exits non-zero if any case
doesn't hold.

## Options worth knowing

- `--repo` uses a local checkout instead of the task file's `repo.url`; `--ref` overrides its `ref`.
- `--models` takes Ollama tags, or names of `openai`-provider workers from your crew config
  (`--config` to point at one). Local OpenAI-compatible servers are experimental; see the main README.
- `--ctx` sets `num_ctx` for every Ollama model (default: the local worker's configured `numCtx`).
- The baseline (your configured local model, unless `--baseline`/`--no-baseline`) always runs first.
- Bench calls use a separate crew state dir, so they don't show up in `crew_stats`.
