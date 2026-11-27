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
pi install npm:@mzwing/pi-permission-auto-review
pi install npm:@gotgenes/pi-permission-system
```

It needs Pi 1.5.0 or later and `@gotgenes/pi-permission-system` 37.x to 42.x.

Pi runs `tool_call` handlers in extension load order. Load this extension
before pi-permission-system. The auto-review handler must capture the
complete tool input before the authorizer runs.

For investigation, install a BYOS provider with copy support. For example,
with a built MXC checkout, run `pi install ~/src/pi-byos-mxc`.
The provider can load before or after pi-permission-system. Pi waits for the
provider to record the pending call before it runs the permission hooks.

Put the entries in your personal settings as shown below. In
`~/.pi/agent/settings.json`, Pi records the MXC checkout relative
to the agent directory.

```json
{
  "packages": ["npm:@mzwing/pi-permission-auto-review", "npm:@gotgenes/pi-permission-system", "../../src/pi-byos-mxc"]
}
```

Pi loads `-e` extensions and extensions from settings or extension directories
before packages. It loads project packages before personal packages. If
pi-permission-system loads from an earlier source, reordering the personal
`packages` list cannot put auto-review before it.

To review permission asks, add auto-review to pi-permission-system's authorizer
chain in `~/.pi/agent/extensions/pi-permission-system/config.json`:

```json
{
  "authorizerChain": ["auto-review"]
}
```

The `codex` preset uses Pi's `openai` provider. Run `/login openai` and choose
"Sign in with ChatGPT" to use a ChatGPT subscription. An explicit
`"provider": "openai-codex"` configuration still uses the separate Codex login.
The `claude-code` preset needs an `anthropic` login.

For ordinary calls, the reviewer sees the asks that your pi-permission-system
rules send to it. Claude Code approves most reads and edits inside the project
without its reviewer. To do the same, allow them in pi-permission-system's rules.

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

- `allow`: the reviewer approves the action. The permission gate and BYOS
  still apply their policies.
- `deny`: the call is refused, and the agent receives the reason with an
  instruction not to work around it.
- `defer`: for a permission ask, pi-permission-system moves to the next
  authorizer in the chain or asks you. The reviewer defers when the model
  fails or times out, the call's input is unavailable, the ask comes from
  a subagent, the write or edit targets Pi's configuration and extension
  directories, or your messages change during review. These directories are
  the agent directory and the project's `.pi/`. Pi loads settings, packages
  and extensions from them without a sandbox.
- When you interrupt the turn, a review in progress ends with a refusal, so you
  are not asked about a turn that you have just stopped.

With the `codex` preset, three refusals in a row, or ten among the last fifty
reviews, stop the agent, as in Codex: the extension warns you, interrupts the
turn, and refuses further asks without review until the next run. The
`claude-code` preset passes the ask that reaches its limit to you.

The footer and `/auto-stats` show whether the reviewer is registered and
whether pi-permission-system has sent it an ask in this session. They show
the load order to use if an ask arrived before capture. The footer counts
automatic allows, denials and deferrals. With the `codex` preset, it also
shows the most recent investigation outcome.

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

With the `codex` preset, the reviewer can inspect a [private copy][investigation]
of the proposed command's workspace. The copy blocks network access, access to
host user data and writes to the host workspace. The first investigation call
opens the copy. Later calls in that review use the same copy. The reviewer
attempts to close it when the review ends.

BYOS supplies routes for its Bash and PowerShell tools. The reviewer uses the
transcript for native file tools and other unrouted calls. A failed copy also
falls back to the transcript. The decision log records the reason.

[investigation]: docs/codex-parity.md#investigation

## Sandbox escalations

BYOS Bash and PowerShell calls can use `escalate` and `justification` to request
extra access. The `codex` preset reviews the destination and restrictions that
BYOS chose for the call. A host destination runs without a sandbox. The agent
writes the justification, which cannot authorize the request.

With BYOS providing an active sandbox for the shell tools, configure
pi-permission-system to allow sandboxed commands. For example, merge these
rules into the pi-permission-system config:

```json
{
  "authorizerChain": ["auto-review"],
  "permission": {
    "bash": { "*": "allow" },
    "powershell": "allow"
  }
}
```

These rules apply even when no sandbox is active. Use them only with an
active BYOS sandbox for the shell tools. Other permission rules, such as a
path rule, can still require a separate decision. The authorizer chain routes
those asks to auto-review.

BYOS runs ordinary commands under the sandbox policy without a confirmation.
The `codex` preset reviews pending escalations during tool capture, including
commands that pi-permission-system allows by rule. A current automatic allow
or deny decides the escalation without a confirmation. If the review defers
or the `claude-code` preset is active, BYOS asks you to confirm the escalation
before it grants the extra access.

If a permission rule asks about the command and the ask reaches you, that
prompt comes first. The Bash prompt does not use registered input formatters.
The PowerShell prompt can preview the escalation, but can clip or omit its
terms. The permission system does not report which terms appeared. The answer
to the command prompt cannot decide the escalation, so BYOS still asks you
to confirm a deferred escalation after you approve the command.

Run `/auto-escalations` to see the automatic decisions and rationales from the
current session. Pass a tool call ID to filter the list.

## Running a refused command anyway

When the reviewer refuses a shell command and Pi can show you a confirmation,
the agent can ask you to run that exact command with
`request_manual_approval`. You see the command first and the agent's reason
last. Approving runs the captured command once, through the normal permission
checks; rejecting stops the agent retrying it until you give new direction.
See [manual approval][manual-approval].

Manual approval applies to ordinary shell calls. BYOS binds each escalation
decision to its tool call ID, destination and restrictions. A replay would
be a new escalation that BYOS would need to decide separately.

[manual-approval]: docs/manual-approval.md

## Statistics

`/auto-stats` compares automatic allows, denials, deferrals and estimated
review cost for this session and your whole Pi profile.
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
