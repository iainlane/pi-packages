# Asking the person about a refused command

When automatic review refuses a `bash` call, and the session can show you a
confirmation, the refusal includes a denial reference. The agent can then ask
you to run that exact command anyway:

```ts
request_manual_approval({
  denial_id: 'the reference from the refusal',
  reason: 'Why the command is needed despite the refusal.',
})
```

The tool takes no command or arguments of its own, so the agent cannot change
what runs. The reason must contain text and is at most 2,000 characters.

Only refusals by the reviewer offer a reference. Refusals by static rules or by
the denial limit, review failures, forwarded subagent asks and calls whose
input was not captured do not.

## What you see

The confirmation shows the tool, the working directory and the command first,
one line per line of the command, then any other arguments, the automatic
refusal and, last, the agent's reason, which the confirmation labels as the
agent's and not yours. Characters that could hide or reorder text on a terminal
are shown escaped; the command that runs is unchanged. In the terminal the
confirmation is paged and defaults to Reject, and Approve once takes effect only
after the last page has been shown. Over RPC the client receives the whole
text.

Only an explicit approval runs the command. Rejecting, dismissing, having no
UI, cancelling the turn and five minutes without an answer all leave it
unrun.

## How the command runs

After you approve, the extension checks that the session still matches the
refusal: no new user evidence, context edits, branch change, tool change, other
working directory or cancellation. It then runs the captured input once through
Pi's normal tool path, with its usual validation, hooks and permission checks.
For that one nested call, and no other, this extension answers its permission
asks with an allow instead of reviewing them again. A static deny rule, an
earlier link in the authorizer chain, or a delegation cap that asks you again
still applies. The approval ends when the call finishes, fails or is
cancelled.

## Rejections

When you reject a command, the agent cannot run it again directly or appeal it
again until you give new direction, such as a new message or an answer to a
question. Extension-sent messages and the agent's reasons do not count. The
rejection is kept in the session as a custom entry with a digest of the action,
so it survives a reload; approvals are never restored from the session. A
reference expires after fifteen minutes, when you send a message, when the run
ends, or when the session changes.

The extension records each approval's steps in the session as custom entries,
separately from the permission system's own events, and counts them in
[`/auto-stats`][status]. Approving does not count as an automatic allow.

[status]: status.md

## Limits

Extensions and the host UI run in the same process. The binding stops the
agent from changing the command after you approve it; it does not protect
against a malicious installed extension. Approving the exact arguments does
not freeze the files, environment or remote state that the command uses.
