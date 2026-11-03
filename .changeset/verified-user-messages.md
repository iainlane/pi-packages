---
'@mzwing/pi-permission-auto-review': major
---

Only user messages that Pi received from the interactive UI or RPC can authorize an action, with either preset. The extension records each message's source in its own session entries; messages from extensions and messages recorded before this version reach the reviewer marked as unverified. When a skill, prompt template or input handler changed what the person typed, the typed text counts as the user's and the expansion is untrusted. With the `codex` preset, a review defers while the branch has a user message whose source is uncertain; the `claude-code` preset shows such a message as `uncertain_user`, whose restrictions apply but which cannot give consent.
