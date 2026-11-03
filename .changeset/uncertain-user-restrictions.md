---
'@mzwing/pi-permission-auto-review': minor
---

With the `codex` preset, a user message whose origin the extension cannot establish no longer sends every later ask on its branch to the human prompt. The reviewer receives it whole as an `uncertain_user` record: its restrictions bind even for low-risk actions, but it cannot authorize an action, broaden a grant or lift a restriction. Compaction never removes it, and a context edit that removes or replaces it defers the review.
