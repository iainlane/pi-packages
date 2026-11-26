---
'@mzwing/pi-permission-auto-review': minor
---

The `codex` preset can decide BYOS escalations for routed Bash and PowerShell calls. It reviews the requested access and the execution destination that BYOS chose. BYOS uses a current automatic allow or deny for that pending call. The `claude-code` preset defers escalations. Use `/auto-escalations [tool-call-id]` to see the automatic decisions and rationales from the current session.

The PowerShell permission prompt can preview a deferred escalation before BYOS asks for its own confirmation.
