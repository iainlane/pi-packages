# Automatic review statistics

`/auto-stats` compares what automatic review did in the current session with
the totals for every session of the Pi profile: how many asks it allowed,
refused and left without a decision, and an estimated cost. It also shows the
reviewer's model, whether investigation is available, when the global totals
started, and any problem that makes a total incomplete. The command makes no
model requests, and its report never goes into the session or any model's
context.

## Commands

- `/auto-stats`: the overview.
- `/auto-stats details`: choose a scope, then Activity, Tokens and cost, Human
  approvals, Models or Recording problems.
- `/auto-stats session [activity|usage|human|models|coverage]`: one section for
  this session; the default is activity.
- `/auto-stats global [activity|usage|human|models|coverage]`: one section for
  the profile.
- `/auto-stats text`: the overview and every section of both scopes as plain
  text.

`details` uses Pi's selection dialogs, so it works only in the terminal UI; over
RPC it lists the direct section commands instead. Cancelling a dialog shows
nothing, and neither does a report for a session that has since ended. In print
mode the report goes to stderr, since stdout carries the agent's answer. On a
narrow terminal the overview shows the two scopes one after the other. Each
breakdown, such as the models or the reasons why reviews did not decide, lists
at most 20 entries and says how many it left out, listing first the problems
that make the cost incomplete; the totals always include everything.

## What is counted

- **Reviews** are the permission asks that this extension answered, including
  asks that it deferred without a review, such as a forwarded subagent ask. One
  tool call can raise several asks.
- **Model calls** include retries, investigation steps and the second stage of
  the `claude-code` preset. A call that failed without reporting any usage
  counts as failed and costs nothing. A call that was still waiting for its
  result when its review ended counts as without usage until the result
  arrives.
- **Human prompts** count the asks that this extension deferred and that
  pi-permission-system then showed to you, with your answer and how long the
  prompt waited. Approving for the session counts as an approval; a prompt that
  timed out or could not be shown counts as without an answer.

The estimated cost uses Pi's model catalogue. The derived `codex-auto-review`
model has no catalogue entry, so its calls use the prices of the Codex model
that the descriptor is based on, and the report says so. The cost shows as
`Incomplete` while any call has not reported usage, a model has no price, or a
record could not be read. It is an estimate, not an invoice.

## Where the totals are kept

Each review appends one custom entry to the session, with its calls and their
usage, and nothing else: no actions, commands, paths, transcript text or
reasoning. Session totals come from every such entry in the session file,
abandoned branches included. An entry copied into a fork or clone keeps a
digest of its original session and does not count again in the copy.

The global totals are in `extensions/pi-permission-auto-review/statistics/statistics.sqlite`
under Pi's agent directory, so each profile has its own. The extension opens
the database at the first review, creating the directory readable only by you
and the file with mode 0600, and refuses a directory or file that is a symbolic
link or belongs to another user. On platforms without POSIX ownership and modes
it cannot check this, and global totals are unavailable there. Several Pi
processes can update the database at once: each writes its changes in one
transaction about a second after a review, and a process that finds another one
writing keeps its changes and tries again later. If a write fails in a way that
might still have saved it, the process stops writing global totals, because
trying again could count the same reviews twice.

The session entries and the database are separate writes, so a crash between
them can leave the global totals behind the sessions.

## Late results

A provider can return a result after its review ended, for example when you
interrupt the turn. The extension waits up to two seconds at shutdown for
interrupted reviews to record their verdicts. Usage that arrives later is added
to the session as a late entry while the session is open; after the session has
ended it goes only into the global totals, and the report notes that some
results arrived after their session ended.
