---
'@mzwing/pi-permission-auto-review': minor
---

The `codex` preset reviews pending BYOS escalations for Bash and PowerShell, including commands that pi-permission-system allows by rule. It reviews the requested access and the execution destination that BYOS chose. A current automatic allow or deny decides the escalation without confirmation. BYOS still asks the user to confirm a deferred escalation, including every escalation under the `claude-code` preset. Use `/auto-escalations [tool-call-id]` to see the automatic decisions and rationales from the current session.

The PowerShell permission prompt can preview a deferred escalation before BYOS asks for its own confirmation.
