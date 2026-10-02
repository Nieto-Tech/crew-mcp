# Changelog

All notable changes to crew-mcp are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-10-02

### Fixed
- A scout that stops exploring with only a lead-in ("I have enough to answer. Final report:") no
  longer comes back as an empty answer marked "reformatted". An answer that isn't the task's JSON
  on a turn that still offered tools is now redone as the forced final turn before any reformat
  turn, and a reformat that yields an all-empty skeleton counts as failed (unstructured).
- When a task uses up its malformed tool call retries, the error now says so.

## [0.2.0] - 2026-10-01

### Added
- Benchmark task files: `npm run bench -- --tasks-file <module>` takes a pinned repo, review tasks
  planted from `.diff` files, and recon tasks, each with its own scoring rules. `--check` runs a
  task file's canned cases through the real scorers without a model; `--dry-run` checks every
  plant applies. A task file's `repo.url` may be a git URL (cloned once into `bench/.cache`) or a
  path. See `bench/README.md`.
- MIT license.
- Public benchmark tasks (Ghost, Medusa) are planned; 0.2.0 ships the engine without a public
  task file.
- `CONTRIBUTING.md`, `SECURITY.md`, a bug report template, CI on Node 20 and 22 (Ubuntu and
  Windows), and a manual-only npm publish workflow with provenance.

### Changed
- The benchmark engine ships no tasks of its own; its tests use synthetic fixtures only.
- Local OpenAI-compatible servers (llama-server, vLLM, LM Studio) are documented as
  experimental: they are tested against a fake server, not yet a real one.
- README corrected against the code: the `readBudgetChars` guidance for llama-server and the
  `crew_status` line for a model that isn't pulled.

### Fixed
- Windows: the Codex CLI (installed by npm as a `.cmd` shim) is now found on `PATH` and run
  through `cmd.exe` with every argument escaped. Before, crew spawned `codex` directly, which
  Node can't do for a `.cmd` file without a shell.
- Windows: benchmark worktrees are checked out without CRLF conversion, so `.diff` plants apply.
- Benchmark scoring: an over-reservation pattern no longer matches inside an identifier.

## History before 0.2.0

The 0.1.x series was developed privately. In summary:

- **0.1.0–0.1.2:** the crew tools (`crew_status`, `crew_recon`, `crew_review_diff`,
  `crew_second_opinion`, `crew_check_citations`); the anchored quote gate and adjacent-identifier
  citation checks; untracked AI-tool state skipped from reviews; usage guidance shipped as MCP
  server instructions.
- **0.1.3–0.1.5:** the diff size gate; `.crew.json` repo policy (`cloud: false`, failing closed);
  partial answers at the deadline instead of timeouts; thinking control per turn; one request at a
  time per local worker, with a queue wait cap.
- **0.1.6–0.1.8:** empty or cut-off final answers retried without thinking; code maps for recon and
  review; malformed tool calls retried; case-insensitive model tags; the benchmark harness;
  OpenAI-compatible local servers (llama-server) as workers.
- **0.1.9:** usage stats (a metadata-only log, `crew_stats`, a `today:` line in `crew_status`).
- **0.1.10–0.1.11:** one reformat turn for answers that aren't the tool's JSON, guarded so it may
  only restructure (no new file paths or evidence quotes); reformat turns logged to an owner-only
  file; up to two retries per task for malformed tool calls.

[Unreleased]: https://github.com/Nieto-Tech/crew-mcp/compare/v0.2.1...main
[0.2.1]: https://github.com/Nieto-Tech/crew-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Nieto-Tech/crew-mcp/releases/tag/v0.2.0
