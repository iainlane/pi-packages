---
'@mzwing/pi-permission-auto-review': minor
---

With the `codex` preset, the ask that reaches the denial limit (three denials in a row, or ten among the last fifty reviews) is now denied with its review's reason, and the extension warns and interrupts the agent's turn, as Codex does. Further asks before the run ends are refused without review, including a review that finishes with an allow after the limit was reached. The count starts again with each agent run instead of each turn.
