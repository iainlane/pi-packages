---
'@mzwing/pi-permission-auto-review': minor
---

When the reviewer refuses a shell command and the session can show a confirmation, the refusal includes a denial reference, and the agent can call `request_manual_approval` with it and a reason to ask you to run that exact command anyway. The confirmation shows the command first and the agent's reason last, and in the terminal it approves only after the last page has been shown. An approved command runs once through Pi's normal tool path and permission checks; a rejected one cannot be retried or appealed until you give new direction.
