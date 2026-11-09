---
'@mzwing/pi-permission-auto-review': patch
---

Default the `codex` preset to `openai/codex-auto-review` so it uses Pi's OpenAI provider and its Sign in with ChatGPT authentication. Resolve the hidden reviewer model from an OpenAI Responses descriptor; previously the resolver accepted only the separate Codex provider and transport. Explicit `openai-codex` configurations remain supported.
