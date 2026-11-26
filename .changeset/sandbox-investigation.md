---
'@mzwing/pi-permission-auto-review': major
---

The `codex` reviewer can use shell and read tools in a private BYOS copy of a routed command's workspace. The reviewer offers tools only after BYOS finds a copy profile that blocks networking, access to host user data and writes to the host workspace. The reviewer opens the copy on its first investigation call and attempts to close it when the review ends. If cleanup is unconfirmed, the decision log includes the failures and any recovery details. Each review can make eight calls and receive 64 KiB of output. The footer and `/auto-stats` show the most recent investigation outcome, including the reason when the reviewer had no suitable copy. Pi 1.5 is now required. The package archive includes the pinned BYOS SDK, so installation does not need to fetch its Git dependency. BYOS provider extensions supply their own settings.
