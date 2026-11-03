---
'@mzwing/pi-permission-auto-review': major
---

The reviewer now judges the complete input of the call that Pi is about to run, including nested `codemode` calls, captured before `@gotgenes/pi-permission-system` asks about it. The extension must load before pi-permission-system. An ask without a captured input, with an input that another extension changed after the capture, or from a forwarded subagent defers to the next authorizer or the human prompt. A write or edit to Pi's settings or to this extension's or pi-permission-system's configuration also defers. `buildReviewPrompt` and the codex review prompts now take a `ReviewAction` in place of the optional tool input, and `renderClaudeCodeTranscript` accepts the captured action.
