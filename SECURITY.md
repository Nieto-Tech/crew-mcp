# Security policy

## Reporting a vulnerability

Please report security issues **privately**, through GitHub's security advisories: on this
repository, open **Security → Advisories → Report a vulnerability**. Don't open a public issue,
pull request or discussion for a suspected vulnerability.

Include what you found, how to reproduce it (a minimal repo, `.crew.json` and crew config are
ideal), the crew version (`crew_status` prints it), and the impact you see. You will get an
acknowledgement, and we'll keep you updated until it's fixed and disclosed. Fixes go into the
latest release; older versions are not patched.

## In scope

crew makes promises about where your code goes and what counts as checked. A way to break any of
them is a vulnerability:

- **Repo policy (`.crew.json`).** With `"cloud": false`, no content may reach a cloud worker, with
  no fallback. That includes: a local-host check that can be fooled (a hostname, IPv6 form or
  redirect that sends a prompt off the machine or private network), a `.crew.json` that should fail
  closed but doesn't (unreadable, malformed, a dangling symlink, a nested file loosening a parent),
  and `crew_second_opinion` reaching a cloud reviewer when the policy forbids it.
- **The quote gate.** A finding or recon risk counts as *quote-checked* only if its quoted code
  really exists at (or uniquely near) the cited place. Anything that makes invented code pass as
  quote-checked, including through the reformat turn introducing paths or quotes the model's
  answer didn't have, is in scope.
- **Citation checks** (`crew_check_citations`) reporting a reference as valid when the file, lines
  or identifier aren't there.
- **Read-only.** Crew tools must never write to the workspace, and the Codex worker runs in its
  `read-only` sandbox. A tool argument that writes, or that reads outside the workspace (path
  traversal, symlinks, a code map outside the repo), is in scope.
- **Local logs.** `usage.jsonl` must hold metadata only; `reformats.jsonl` (answer text) must be
  created owner-only.

## Out of scope

- How good a model's findings are. Quote-checked means the quote exists, not that the claim is right.
- Ollama, llama-server, vLLM, LM Studio and the Codex CLI themselves (report those upstream), and
  exposing an unauthenticated model server to a network you don't trust.
- A LAN proxy that forwards a "local" endpoint to a cloud model: crew trusts loopback and private
  addresses by design, as the README says. Only network egress rules can prevent that.
