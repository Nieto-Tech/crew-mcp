---
name: Bug report
about: Something in crew doesn't work as documented
title: ""
labels: bug
---

<!-- Security issue? Don't file it here: see SECURITY.md (private advisories). -->
<!-- Please redact anything private: repo names, paths, code, hostnames, keys. -->

**What happened**

**What you expected**

**Steps to reproduce**

1.
2.

**`crew_status` output**

<!-- Ask Claude to run crew_status and paste the whole result. It shows the crew version,
config sources, workers, role resolution and repo policy. -->

```
paste here
```

**Environment**

- OS (and version):
- GPU (model and VRAM), or "none":
- Model(s) involved (e.g. the Ollama tag, or ChatGPT via Codex CLI):
- Worker provider: ollama / openai-compatible (which server?) / codex-cli
- Claude Code version (`claude --version`):
- Node version (`node --version`):

**Server logs (optional)**

<!-- crew logs to stderr; Claude Code shows them under /mcp. The lines around the failing call
help most. -->
