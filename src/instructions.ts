/**
 * Usage guidance sent to the client (Claude Code) when it connects. This is the
 * single source of truth for "when should Claude use the crew": it ships with
 * the server, so it's versioned with the tools and only present when crew is.
 */
export const CREW_INSTRUCTIONS = `crew: a local GPU model and ChatGPT, available as crew_* tools. Use them to save
your own context and to get independent checks. Claude stays the lead.

- Mapping a flow across more than a few files: call crew_recon first and read only
  what it points to. It's a cheap first pass, not proof: confirm load-bearing claims.
- After changing code, before saying you're done: call crew_review_diff. Fix or
  explicitly rebut every quote-checked finding. Quote-checked means the quoted code
  exists where claimed; it doesn't prove the claim. Unverified findings are hints:
  check the plausible ones, ignore the rest. It is for normal-sized changes. For a new
  repo, a big refactor or generated code it will say the diff is too large: review the
  riskiest files via \`paths\` instead, or skip it. Don't reach for force.
- Risky changes (payments, auth, migrations, concurrency, data deletion): also call
  crew_second_opinion with includeDiff true and your reasoning. Weigh disagreement on
  the merits; don't defer just because it disagrees.
- Before presenting analysis with file:line references: run crew_check_citations
  and fix anything invalid.
- Crew calls can take 1-2 minutes. That's expected; don't retry or poll. If a crew
  tool errors, run crew_status once and report what it says.
- The local GPU runs one crew call at a time, shared by every Claude session on this
  machine; other calls wait their turn in a queue. Calls sent in parallel don't finish
  sooner, they queue: send one call with a broader question rather than several narrow
  ones at once. A queued call can take several minutes; that's the queue, not a hang.
  If one fails because the worker is busy, don't resend it straight away.
- A crew call blocks your turn until it returns, queue time included. When a recon
  isn't needed for your very next step, hand it to a background subagent and keep
  working; use its result when it arrives. Call crew_review_diff directly: it gates
  "done", and the queue lets it go ahead of waiting recons.
- When reporting crew results, keep three things distinct: what the crew claimed,
  what you verified yourself, and what is still unverified.
- Every crew result starts with a "_via ..._" line naming the worker, model, time and
  work done. When you report a crew result to the user, quote that line verbatim so they
  can see what ran and where. crew_stats shows usage totals if they ask.
- A repo's .crew.json policy (e.g. cloud:false for PHI) is enforced by crew itself:
  cloud workers are never used there and there is no fallback. If a tool says it's
  disabled or unavailable by repo policy, don't work around it; tell the user.
- If the project's CLAUDE.md says how crew fits that repo's own tooling, follow it.`;
