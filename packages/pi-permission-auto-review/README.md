# @mzwing/pi-permission-auto-review

[![npm][npm-badge]][npm]

[npm-badge]: https://img.shields.io/npm/v/@mzwing/pi-permission-auto-review
[npm]: https://www.npmjs.com/package/@mzwing/pi-permission-auto-review

When [`@gotgenes/pi-permission-system`][permission-system] would ask you whether
[Pi][pi] may run a tool call, this extension asks a reviewer model first. The
reviewer allows the call, refuses it with a reason that the agent sees, or
leaves it to you. You choose the reviewer with a preset:

- `codex`, the default, is OpenAI's `codex-auto-review` model with an
  adaptation of [Codex's Guardian policy][guardian]. It follows Codex's
  reviewer closely: what counts as your instruction, how the transcript is
  built, when the agent is stopped, and the optional read-only investigation.
- `claude-code` is the two-stage check of [Claude Code's auto mode][auto-mode],
  on Claude Sonnet 5 by default, with its prompt and rules written anew for Pi.

[`@gotgenes/pi-permission-model-judge`][model-judge] is a general-purpose model
authorizer. This extension instead reproduces the reviewers of two coding
agents, each with the prompt, transcript and review flow of the original.

[permission-system]: https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system
[pi]: https://github.com/earendil-works/pi
[guardian]: https://github.com/openai/codex/tree/main/codex-rs/prompts/templates/guardian
[auto-mode]: https://code.claude.com/docs/en/auto-mode-config
[model-judge]: https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-model-judge

## Install

```bash
pi install npm:@gotgenes/pi-permission-system
pi install npm:@mzwing/pi-permission-auto-review
```

It needs Pi 1.5.0 or later and `@gotgenes/pi-permission-system` 37.x to 42.x.

Load this extension before pi-permission-system. The reviewer judges the
complete input of the call that Pi is about to run, and only a `tool_call`
handler that runs before pi-permission-system sees all of it. Pi runs those
handlers in load order: `-e` extensions first, then the settings `extensions`
paths, then `packages`, each in the order listed. With both in `packages`, put
this one first:

```json
{
  "packages": ["npm:@mzwing/pi-permission-auto-review", "npm:@gotgenes/pi-permission-system"]
}
```

Then add the reviewer to pi-permission-system's authorizer chain, normally in
`~/.pi/agent/extensions/pi-permission-system/config.json`:

```json
{
  "authorizerChain": ["auto-review"]
}
```

The `codex` preset uses Pi's `openai-codex` login, listed as "OpenAI Codex
(legacy)" in `/login`; the `claude-code` preset needs an `anthropic` login.

The reviewer only sees the asks that your pi-permission-system rules send to
it. Claude Code approves most reads and edits inside the project without its
reviewer; to do the same, allow them in pi-permission-system's own rules.

## Configuration

Configuration is optional. The extension merges a global file,
`~/.pi/agent/extensions/pi-permission-auto-review/config.json`, with a project
file, `.pi/extensions/pi-permission-auto-review/config.json`, and reads the
project file only once Pi trusts the project. `preset` chooses the reviewer, and
`provider` and `model` choose the model that it uses:

```json
{ "preset": "claude-code" }
```

`/permission-auto-review` edits the config in a menu and applies it without
reloading the session. See [configuration][configuration] for every field, your
own rules in `autoMode`, and how follow-up reviews continue the reviewer's
conversation.

[configuration]: docs/configuration.md

## What the reviewer decides

- `allow`: the call runs.
- `deny`: the call is refused, and the agent receives the reason with an
  instruction not to work around it.
- `defer`: pi-permission-system moves to the next authorizer in the chain or
  asks you. The reviewer defers when it cannot decide: the model failed or
  timed out, the call's input was not captured, the ask came from a subagent,
  the call would change Pi's settings or the configuration of this extension,
  pi-permission-system or the sandbox, or your messages changed while the
  review ran.
- When you interrupt the turn, a review in progress ends with a refusal, so you
  are not asked about a turn that you have just stopped.

With the `codex` preset, three refusals in a row, or ten among the last fifty
reviews, stop the agent, as in Codex: the extension warns you, interrupts the
turn, and refuses further asks without review until the next run. The
`claude-code` preset passes the ask that reaches its limit to you.

The footer shows whether the reviewer is registered, and how many asks it has
allowed, denied and deferred in the session.

## What counts as your instruction

With either preset, only messages that you sent from Pi's interface or over
RPC can authorize an action. Messages that other extensions send are shown to
the reviewer as untrusted. When a skill or prompt template expanded what you
typed, your typed text counts and the expansion does not. When the extension
cannot establish where a message came from, the message can still restrict the
action but cannot authorize it.

The `codex` preset also counts your answers to recognized question tools such
as `ask_user` and your approvals in `submit_plan`. It passes every one of your
messages to the reviewer in full, including messages that compaction removed
from the agent's context. When a session is too long for the reviewer model, it
leaves out other records first and then shortens your messages longer than 900
tokens, oldest first. If that is not enough, the ask comes to you.

## Investigation

With the `codex` preset, the reviewer can check local facts before it decides,
such as a file's contents or where a repository's remote points, by running
read-only commands in the sandbox that you configured with
[pi-bring-your-own-sandbox][investigation]. The SDK is included, but you must
load a provider extension separately. Investigation needs a backend that cannot
write files or reach the network. When your sandbox cannot provide one, which
includes the default of running on the host, the reviewer judges from the
transcript alone and the footer shows `no investigation` with the reason.

[investigation]: docs/codex-parity.md#investigation

## Running a refused command anyway

When the reviewer refuses a shell command and Pi can show you a confirmation,
the agent can ask you to run that exact command with
`request_manual_approval`. You see the command first and the agent's reason
last. Approving runs the captured command once, through the normal permission
checks; rejecting stops the agent retrying it until you give new direction.
See [manual approval][manual-approval].

[manual-approval]: docs/manual-approval.md

## Statistics

`/auto-stats` compares this session with your whole Pi profile: how many asks
the reviewer allowed, refused and left to you, and the estimated cost.
`/auto-stats details` opens one section for either scope: activity, tokens and
cost, human approvals, models, or recording problems. `/auto-stats text` prints
every section as plain text. See [statistics][status] for the commands that
open a section directly.

[status]: docs/status.md

## Limits

- Evidence is text only; the reviewer never sees images.
- A tool call handler that loads after pi-permission-system can still change a
  call after the reviewer approved it.
- The records of where each message came from are ordinary session entries,
  which another installed extension could write.
- Asks from subagents always go to you.

[Parity with Codex][parity] explains these limits, each place where the `codex`
preset departs from Codex, and what Pi would need to close the gaps.
[Live evaluation][live] describes the optional tests against a real reviewer
model.

[parity]: docs/codex-parity.md
[live]: docs/live-evaluation.md

## Programmatic use

`@mzwing/pi-permission-auto-review/review` exports the `codex` preset's prompt
and verdict pipeline, which needs no running Pi session:

```ts
import {
  buildReviewPrompt,
  DEFAULT_CONFIG,
  parseReviewAssessment,
  renderTranscript,
} from '@mzwing/pi-permission-auto-review/review'

const transcript = renderTranscript(sessionManager.getBranch(), sessionManager.buildSessionProjection())
// `action` is the complete call as a ReviewAction
const prompt = buildReviewPrompt(DEFAULT_CONFIG, transcript, details, action)
const assessment = parseReviewAssessment(modelReply)
```

The `claude-code` pipeline is exported beside it, under names such as
`buildClaudeCodeSystemPrompt`, `renderClaudeCodeTranscript` and
`parseClaudeCodeVerdict`.

## License

[MIT](LICENSE)
