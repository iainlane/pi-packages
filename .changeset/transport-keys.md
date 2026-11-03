---
'@mzwing/pi-permission-auto-review': patch
---

A review call that starts while an earlier call of the session is still unfinished, such as one abandoned at its attempt timeout or one from an overlapping review, now uses a separate transport key, so the two cannot share a Codex WebSocket continuation.
