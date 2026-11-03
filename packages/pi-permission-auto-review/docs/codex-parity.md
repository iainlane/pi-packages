# Parity with Codex's automatic approval reviewer

The `codex` preset reviews Pi permission asks as closely as it can to the way
that Codex's guardian reviewer handles approval requests. This document records
the Codex release used as the reference, what Pi and pi-permission-system give
an authorizer, and where the preset departs from Codex because of that.

## Reference revisions

| Component     | Revision                                                                            |
| ------------- | ----------------------------------------------------------------------------------- |
| Codex release | [`rust-v0.166.0`][codex-release], commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` |
| Pi            | `@earendil-works/pi-coding-agent` 1.4.0                                             |
| Permissions   | `@gotgenes/pi-permission-system` 42.0.0                                             |

The reference is the synchronous reviewer: the
`approvals_reviewer = "auto_review"` path, which is stable and enabled by
default in that release. The asynchronous Guardian scorers and the history tools
behind development feature flags are out of scope.

[codex-release]: https://github.com/openai/codex/tree/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/ext/guardian-reviewer

## What the host gives an authorizer

`test/host.test.ts` runs Pi, pi-permission-system and this extension in one
process and records these facts.

| Capability                           | Pi and pi-permission-system                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Complete tool input                  | Not supplied for every tool. For bash, the payload contains the asking command unit and the full command. For writes and edits, the request contains a line and character summary. For other tools, including native `mcp__` tools, `toolInputPreview` contains the whole input as JSON with credential-like values masked; the display preview stops at 200 characters. |
| Nested `codemode` calls              | Each nested call raises its own `tool_call` event and ask, with the id `<parent id>/<n>`. Nested calls never appear in the transcript.                                                                                                                                                                                                                                   |
| Binding the review to executed input | Pi executes the object that the `tool_call` handlers see. A handler that runs after pi-permission-system can still change it, and Pi does not validate it again.                                                                                                                                                                                                         |
| Forwarded subagent asks              | The parent's authorizer receives the child's payload and requester only: no tool call id, tool input or child transcript.                                                                                                                                                                                                                                                |
| Who wrote a user message             | Session entries do not record it. The `input` event reports `interactive`, `rpc` or `extension` while the message is submitted.                                                                                                                                                                                                                                          |
| Model-visible context                | `buildSessionProjection()` applies compaction and `context_edit` entries; `getBranch()` returns the raw history.                                                                                                                                                                                                                                                         |
| Deterministic denials                | A static deny rule refuses the call before any authorizer runs.                                                                                                                                                                                                                                                                                                          |

## Load order

Pi runs `tool_call` handlers one at a time, in extension load order. The host
test shows two consequences:

- A handler that loads before pi-permission-system runs before the authorizer
  and sees the complete validated input, with arguments already converted to
  their schema types: a `timeout` of `'10'` arrives as `10`.
- A handler that loads after pi-permission-system runs after the verdict. If it
  rewrites `event.input.command`, the rewritten command runs, even though the
  reviewer approved the original one.
