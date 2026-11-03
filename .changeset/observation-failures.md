---
'@mzwing/pi-permission-auto-review': patch
---

A failure to write the decision log, record statistics or update the footer no longer changes the reviewer's verdict, and any other unexpected failure defers the ask exactly once instead of blocking the call.
