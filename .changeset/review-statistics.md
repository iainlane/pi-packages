---
'@mzwing/pi-permission-auto-review': minor
---

`/auto-stats` shows how many asks automatic review allowed, refused and left to you, with an estimated cost, for the current session and for every session of the Pi profile. `/auto-stats details` opens the Activity, Tokens and cost, Human approvals, Models and Recording problems sections, which `/auto-stats session <section>` and `/auto-stats global <section>` show directly and `/auto-stats text` shows all at once. Each review appends one content-free custom entry to the session; the profile's totals are kept in a private SQLite database under Pi's agent directory.
