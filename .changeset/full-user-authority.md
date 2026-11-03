---
'@mzwing/pi-permission-auto-review': major
---

The `codex` preset shows the reviewer every verified user message and recognised question answer in full, from the raw branch, so compaction never removes them; the rest of its evidence comes from Pi's session projection with Codex's caps. When the request would not fit the reviewer model, other evidence is left out first, then user messages longer than 900 tokens are shortened, oldest first, and the review defers only when the evidence still cannot fit. A review defers when a context edit removed or replaced user evidence; other edited text reaches the reviewer as untrusted `edited_user`. A follow-up review starts over in full after a context edit or compaction. `renderTranscript` now takes the session projection and returns an evidence manifest.
