## Crew (MCP server: `crew`)

<!-- FALLBACK ONLY. crew sends these instructions to Claude automatically when it
connects. Add this to ~/.claude/CLAUDE.md only if your client doesn't pick them up
(see "Tell Claude when to use it" in the crew README). -->

A local GPU model and ChatGPT are available as `crew_*` tools. Use them to save
context and get independent checks. Skip this section if the `crew` server isn't
connected.

- **Mapping a flow across more than a few files:** call `crew_recon` first and read
  only what it points to. It's a cheap first pass, not proof: confirm load-bearing
  claims before relying on them.
- **After changing code, before saying you're done:** call `crew_review_diff`. Fix or
  explicitly rebut every *quote-checked* finding. Quote-checked means the quoted code
  exists where claimed; it doesn't prove the claim. *Unverified* findings are hints.
- **Risky changes** (payments, auth, migrations, concurrency, data deletion): also
  call `crew_second_opinion` with `includeDiff: true` and your reasoning. Weigh
  disagreement on the merits; don't defer just because it disagrees.
- **Before presenting analysis with file:line references:** run
  `crew_check_citations` and fix anything invalid.
- Crew calls can take 1–2 minutes. That's expected; don't retry or poll. If a crew
  tool errors, run `crew_status` once and report what it says.
- When reporting crew results, keep the distinction clear: what the crew claimed,
  what you verified yourself, and what's still unverified.
- If a project's CLAUDE.md says how crew fits that repo's own tooling, follow it.
