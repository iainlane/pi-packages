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

## What the extension does with it

- A `tool_call` handler captures the validated input of every call, nested
  `codemode` calls included, keyed by tool call id, with a digest, the cwd,
  the session and the tool's registration. The reviewer judges a typed action
  built from the capture.
- An ask without a capture, with a capture for another tool or session, or
  with an input that another extension changed after the capture, defers to
  the next authorizer or the human prompt.
- Forwarded subagent asks defer, because the parent receives neither the
  child's input nor its transcript.
- A write or edit whose path resolves, through any symlinks, into Pi's
  settings or into this extension's or pi-permission-system's configuration
  defers. The policy treats such a change made through a shell command as
  permission tampering.
- The extension records in its own session entries whether each user
  message came from the interactive UI, RPC or an extension. With the `codex`
  preset, only a message from the interactive UI or RPC counts as the user's.
  When a skill, prompt template or input handler changed what the person typed,
  the typed text counts and the expansion is untrusted. A message that the
  extension cannot attribute with confidence defers every review on its
  branch.
- See [context edits and compaction](#context-edits-and-compaction) for how
  the `codex` preset builds its evidence.
- A verdict applies only if the session still matches what the review read.
  See [freshness](#freshness).
- As in Codex, three denials in a row or ten among the last fifty reviews
  interrupt the agent's turn with `ctx.abort()`, and later asks in the same run
  are refused without review. Codex counts denials across everything the agent
  does for one prompt. Pi starts a turn before every model response, so the
  count starts again when an agent run starts or settles, not at each turn.

## Context edits and compaction

Codex keeps user messages out of ordinary transcript truncation, keeps them
across compaction and counts them first against its message allowance. The
`codex` preset does the same. Verified user messages and recognised question
answers come from the raw branch in full, so compaction does not remove them.
Everything else comes from `buildSessionProjection()`, the context that the
agent's model sees, with Codex's caps: 5,000 tokens for each message, 1,000
for each tool record and 10,000 for tool records in total, the 40 newest
records, and the 5 newest tool records always kept. Entries before a
compaction cut appear only through the compaction summary, which cannot
establish authorization.

User evidence counts against the 20,000-token message allowance before
anything else, which only crowds out other records. When the whole request
would not fit the reviewer model's context window, other records are left out
first, oldest first. If the user evidence alone still does not fit, user
records longer than 900 tokens are shortened, oldest first, keeping their start
and end. As in Codex, a shorter user record is never shortened, so a short
restriction stays whole. The review defers only when the evidence still cannot
fit.

A `context_edit` takes precedence over both sources, and the reviewer never
receives text that an edit removed or replaced. When an edit removes or
replaces a verified user message or a recognised answer, the review defers:
an extension can write such an edit, and removing a later restriction would
otherwise leave an earlier permission standing. Edits of other entries only
change the evidence, and a replaced user message that was not authority
reaches the reviewer as an untrusted `edited_user` record.

A follow-up review continues the earlier reviews' conversation with only what
the session added. It starts over in full after a context edit or compaction,
because either can change what the earlier reviews saw.

## Freshness

Pi reports no revisions of the state that a review depends on, so the reviewer
records that state before each attempt and checks it again when the verdict
arrives. It records the captured action's digest, the registered tools, the
context edits on the branch, the session and the branch leaf, plus a digest of
the user evidence: user messages, their provenance records, and the calls and
results of the recognised interaction tools.

When only the user evidence changed, for example because the person added a
restriction, the reviewer discards the verdict and reviews the new evidence,
as Codex does when its recorded authorization revision changes. The new attempt
starts a full review, and the review defers after three attempts that each saw
the evidence change. A change to anything else defers the ask. An appended
entry keeps the earlier leaf on the branch, so only moving to another branch
counts as a branch change. Moving through the session tree, compaction,
switching sessions and forking also cancel the reviews in progress.

Like Codex, the reviewer counts only recorded user evidence. Pi runs input
handlers before it records a message, and a handler can consume a submission
without recording anything. A queued or intercepted restriction can therefore
arrive too late to stop the action under review; Pi's cancellation control
interrupts the run.

## Interaction answers

Codex treats the person's answers to its own question prompts as user evidence,
and labels each question with the assistant role and each answer with the user
role. Pi has no built-in question tool, so the `codex` preset recognises the
results of specific tools: `ask_user` from pi-ask-user, `submit_plan` from the
planning extension, and the earlier `ask_user_question` and
`plan_mode_question`. A result counts as an answer only when the assistant
called that tool with the same call id, the call succeeded, and the result
details decode with the tool's schema. A cancelled question, a plan revision
request and a cancelled plan review are not answers.

The reviewer receives each answer as a `user_interaction` record and the
question, context and options as an untrusted `assistant` record before it.
The assistant wrote the questions and option descriptions, so they define what
the answer responds to but cannot authorize anything themselves. As in Codex, a
question and its answer are included whole or left out together: a pair larger
than 900 tokens is left out, and the metadata record reports `answersOmitted`.

A plan approval authorizes implementing the approved revision. Its question
record contains the plan content from the tool result, whatever its size, so a
later change to the plan file does not change what was approved. When the
planning extension clears the context after an approval, the approval remains
authority because it comes from the raw branch, and the extension's follow-up
message is unverified. An older version of the planning extension hands an
approved plan over to a fresh session instead. The approval then remains in the
original session, and asks in the fresh session go to the person, because the
reviewer reads only the current session.

## Provenance trust

The records are ordinary custom entries. They are not signed, and nothing
binds them to an authenticated writer. Another installed extension, or an
edited session file, can add a record that attributes a message to the
interactive UI, and the reviewer accepts it. Two records that disagree make
the message uncertain. The records constrain what the reviewer treats as the
user's words among trusted extensions and trusted session history; they do
not protect against a malicious installed extension. Authenticated provenance
needs an API in Pi.

Pi delivers queued input later and reports no submission identifiers. The
extension matches a queued message to its input by content, steer before
follow-up. It keeps the source of a transformed queued message only while no
other input is queued, and of a transformed idle message only when one
submission could have produced it.

## Load order

Pi runs `tool_call` handlers one at a time, in extension load order. The host
test shows two consequences:

- A handler that loads before pi-permission-system runs before the authorizer
  and sees the complete validated input, with arguments already converted to
  their schema types: a `timeout` of `'10'` arrives as `10`.
- A handler that loads after pi-permission-system runs after the verdict. If it
  rewrites `event.input.command`, the rewritten command runs, even though the
  reviewer approved the original one.

The capture therefore requires this extension to load before
pi-permission-system. The second consequence remains a gap: Codex checks that
an approval still matches the action at the point of execution, and in Pi only
a handler that runs after every other `tool_call` handler could make that
check. Closing the gap needs a change in Pi.

## Departures from Codex

- Forwarded subagent asks go to the human, because the parent cannot see the
  child's action.
