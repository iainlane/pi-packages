---
'@mzwing/pi-permission-auto-review': major
---

The `codex` preset's reviewer can inspect local state before it decides, with a `shell` tool and a `read` tool that run in the sandbox configured through pi-bring-your-own-sandbox. The reviewer asks for a backend that cannot write to the workspace or reach the network; when the configured provider cannot open one, including the default host passthrough, the reviewer has no tools and the footer shows `no investigation` with the reason. A review can make eight calls and receive 64 KiB of output, after which the model must decide without tools. Pi 1.5 is now required. The pinned BYOS SDK is included in the package archive, so installation does not need to fetch its Git dependency. BYOS provider extensions activate themselves and supply their configuration and base policy through a callback.
