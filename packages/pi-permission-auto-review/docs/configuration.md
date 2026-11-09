# Configuration

Configuration is optional. Without it, the `codex` preset reviews with
`openai/codex-auto-review`. If your configuration explicitly sets
`"provider": "openai-codex"`, change that value to `"openai"` to use the new
default provider, then authenticate with `/login openai`.

## Files

The extension reads two files and merges the project file over the global one:

- global: `~/.pi/agent/extensions/pi-permission-auto-review/config.json`, or the
  same path under `PI_CODING_AGENT_DIR` when that variable is set;
- project: `.pi/extensions/pi-permission-auto-review/config.json` in the
  project.

The project file is read only once Pi trusts the project. Until then it is left
out of the merge, so a repository can neither loosen nor break the review of its
own actions. An invalid config turns automatic decisions off until it is fixed.

Files that `/permission-auto-review` writes start with a `$schema` entry, which
editors use to validate the file.

## Fields

| Field              | Default (`codex` / `claude-code`)       | Description                                                   |
| ------------------ | --------------------------------------- | ------------------------------------------------------------- |
| `preset`           | `codex`                                 | `codex` or `claude-code`                                      |
| `provider`         | `openai` / `anthropic`                  | Pi provider id of the reviewer model                          |
| `model`            | `codex-auto-review` / `claude-sonnet-5` | Reviewer model id                                             |
| `reasoning`        | `low` / `high`                          | Reasoning level; `claude-code` uses it for its second stage   |
| `timeoutMs`        | `90000`                                 | Time for a whole review, retries included                     |
| `maxRetries`       | `2`                                     | Retries after a transient failure or a malformed reply        |
| `attemptTimeoutMs` | none                                    | Time limit for one call; without it, only `timeoutMs` applies |
| `followUpReviews`  | `auto`                                  | Whether later reviews continue the reviewer's conversation    |
| `autoMode`         | none                                    | Your own rules, beside or in place of the preset's            |

## Rules

`autoMode` takes the same four lists as Claude Code's `autoMode` settings, so
rules copied from there work here. `environment` tells the reviewer what lies
inside your trust boundary, `hard_deny` rules always block, and `soft_deny`
rules block unless an `allow` exception or your explicit consent clears them.
Each list contains prose rules. The entry `"$defaults"` means the preset's
built-in rules, and a list without it replaces them.

```json
{
  "preset": "claude-code",
  "autoMode": {
    "environment": ["$defaults", "Source control: github.com/acme and every repository under it"],
    "soft_deny": ["$defaults", "Never run database migrations by hand"]
  }
}
```

`/permission-auto-review defaults` prints the active preset's built-in rules.

## Follow-up reviews

As in Codex, a later review in a session continues the reviewer's conversation
and sends only what the session added. With `auto`, the conversation starts
over after a follow-up that the provider served without a cache hit, so an
uncached provider never receives a growing conversation; `always` keeps it
regardless, and `off` sends every review in full, as Claude Code does. A
conversation also starts over when it would pass 256k tokens or the model's
context window, after a context edit or compaction, on another branch, when
the reviewer's investigation tools become available or unavailable, and after a
review fails.

## Editing the config

`/permission-auto-review` opens a menu: choose the global or project scope,
change settings, then save. Saving applies the config without reloading the
session. The subcommands are `show`, `path`, `defaults`, `reset [global|project]`
and `help`.

If the file changes while the menu is open, saving applies the settings that you
changed to the file as it is now and keeps the other edit. If the other edit
changed a setting that you also changed, the save is refused and the message
lists the setting; saving again writes your value.

A save keeps the file's permissions. The command refuses to save or reset a
config file that is a symbolic link or is reached through one, and a project
config that resolves outside the project, so a repository cannot make a project
edit change your global config.
