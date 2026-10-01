## Crew (optional)

<!-- Template for a REPO's CLAUDE.md. Add one only when the repo has its own agents or
skills that crew should fit around; generic crew usage comes from the server itself.
Replace the <placeholders> with this repo's names, and delete lines that don't apply. -->

If the `crew` MCP server is available: use `crew_recon` as a cheap first pass, then
spawn `<your-tracer-agent>` for a verified trace of anything you will rely on. Run
`crew_review_diff` during the normal diff review, before `<your-pre-pr-review-skill>`
and `<your-ship-skill>`. For changes to `<risky-area, e.g. billing or auth>`, also
run `crew_second_opinion`. Without crew, skip this section.
