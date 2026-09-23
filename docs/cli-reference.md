# CLI reference

`omp` is invoked as:

```sh
omp [command] [flags] [messages...]
```

When the first non-flag argument is **not** a registered subcommand, `omp`
routes to the default [`launch`](#launch-the-default-command) command and treats
the arguments as the initial prompt. So `omp "fix the build"` launches a session
with that message, while `omp models` runs the `models` subcommand.

Runtime help is also available:

- `omp --help` lists user-facing subcommands and common launch flags.
- `omp <command> --help` prints that command's public flags and examples.

This page is the consolidated reference for the shared **launch surface** (the
flags accepted by `omp` / `omp launch`) and every top-level **subcommand**.
Per-subcommand flags (for example `omp auth-broker --json`) are documented by
each command's `--help`.

## Launch (the default command)

`omp` and `omp launch` start a coding session. Positional arguments become the
initial message(s):

```sh
# Interactive session
omp

# Interactive session with an initial prompt
omp "List all .ts files in src/"

# Attach files/images to the initial message (prefix with @)
omp @prompt.md @image.png "What color is the sky?"

# Non-interactive: process the prompt and exit (headless / print mode)
omp -p "List all .ts files in src/"

# Continue the previous session
omp --continue "What did we discuss?"
```

Argument handling:

- `@<path>` attaches a file or image to the initial message.
- Non-TTY stdin is read automatically as the initial prompt; do not add a `-`
  marker.
- `--` ends flag parsing; everything after it is literal message text, even if it
  looks like a flag.

### Launch flags

#### Session and workspace

| Flag                  | Description                                                          |
| --------------------- | -------------------------------------------------------------------- |
| `--cwd <dir>`         | Directory to start in (overrides the launch cwd).                    |
| `--add-dir <dir>`     | Add a workspace directory beyond the working directory (repeatable). |
| `--allow-home`        | Allow starting in `~` without auto-switching to a temp dir.          |
| `--profile <name>`    | Use an isolated profile for auth, sessions, settings, and caches.    |
| `--alias <name>`      | Create a shell shortcut for the selected profile and exit.           |
| `--config <file>`     | Load an extra `config.yml`-style overlay for this run (repeatable).  |
| `--session-dir <dir>` | Directory for session storage and lookup.                            |
| `--no-session`        | Don't save the session (ephemeral).                                  |

#### Session history

| Flag                                    | Description                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--continue`, `-c`                      | Continue the previous session.                                                                                                              |
| `--resume [id]`, `-r`, `--session [id]` | Resume a session by ID prefix or path, or open the picker when no value is given.                                                           |
| `--fork <session>`                      | Fork a saved session (by ID prefix or path) into a new session. See [session operations](./session-operations-export-share-fork-resume.md). |
| `--from-claude`                         | Import a Claude Code session into OMP.                                                                                                      |
| `--from-codex`                          | Import a Codex session into OMP.                                                                                                            |
| `--export <session>`                    | Export a session file to HTML and exit.                                                                                                     |
| `--no-title`                            | Disable title auto-generation (equivalent to the `PI_NO_TITLE` [environment variable](./environment-variables.md)).                         |

#### Model selection

| Flag                         | Description                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--model <id-or-role>`       | Model or configured role to use (role: `slow` or `@slow`; fuzzy model match: `opus`, `gpt-5.2`, or `openai/gpt-5.2`). |
| `--smol <id>`                | Smol/fast model for lightweight tasks (or `PI_SMOL_MODEL`).                                                           |
| `--slow <id>`                | Slow/reasoning model for thorough analysis (or `PI_SLOW_MODEL`).                                                      |
| `--plan <id>`                | Plan model for architectural planning (or `PI_PLAN_MODEL`).                                                           |
| `--models <a,b,c>`           | Comma-separated model patterns for `Ctrl+P` cycling.                                                                  |
| `--provider <name>`          | Provider to use (legacy; prefer `--model`).                                                                           |
| `--api-key <key>`            | API key (defaults to env vars).                                                                                       |
| `--provider-session-id <id>` | Reuse a specific provider-side session id for continuity and cache scoping.                                           |
| `--prompt-cache-key <key>`   | Override the provider prompt-cache key for this session.                                                              |
| `--service-tier <tier>`      | OpenAI service tier for this session (`none` omits `service_tier`).                                                   |

See [providers](./providers.md) and [models](./models.md) for model resolution.

#### Thinking and reasoning

| Flag                  | Description                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--thinking <level>`  | Set the thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `auto`.                                                             |
| `--hide-thinking`     | Hide thinking blocks in TUI output (display only; does not disable model thinking).                                                                       |
| `--print-thoughts`    | Include thinking blocks in print-mode text output.                                                                                                        |
| `--external-thinking` | Use a private scratchpad while disabling supported GPT/Claude/Gemini reasoning. Use at your own risk: providers have flagged this request shape as abuse. |

#### Prewalk and plan modes

| Flag                    | Description                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--prewalk`             | Switch to a fast/cheap model at the first edit/write after the plan's todo list exists (default off; see `prewalk.enabled`).                    |
| `--no-prewalk`          | Disable prewalk even if `prewalk.enabled` is set.                                                                                               |
| `--prewalk-into <id>`   | Target model for prewalk (default the `smol` role).                                                                                             |
| `--plan-yolo`           | Force read-only plan mode at start, auto-approve the plan on the model's first resolve call, then switch to `--plan-yolo-into` to implement it. |
| `--plan-yolo-into <id>` | Target model for plan-yolo execution (default the `smol` role).                                                                                 |

#### Tools, approvals, and runtime

| Flag                       | Description                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--tools <a,b,c>`          | Comma-separated list of tools to enable (default: all).                                                                      |
| `--no-tools`               | Disable all built-in tools.                                                                                                  |
| `--no-lsp`                 | Disable LSP tools, formatting, and diagnostics.                                                                              |
| `--no-pty`                 | Disable PTY-based interactive bash execution.                                                                                |
| `--approval-mode <mode>`   | Override `tools.approvalMode` for this session (`always-ask`, `write`, or `yolo`). See [approval mode](./approval-mode.md).  |
| `--auto-approve`, `--yolo` | Auto-approve all tool calls (skip approval prompts).                                                                         |
| `--advisor`                | Enable the advisor runtime (passively reviews each turn and injects notes). See [advisor / watchdog](./advisor-watchdog.md). |
| `--max-time <duration>`    | Stop the session after this duration (e.g. `600`, `10m`, `1h`).                                                              |

#### Extensions, hooks, skills, and rules

| Flag                              | Description                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--extension <path>`, `-e <path>` | Load an extension (repeatable). See [extensions](./extensions.md).                                                |
| `--hook <path>`                   | Load a hook/extension file (repeatable). See [hooks](./hooks.md).                                                 |
| `--trusted-extension <abs-path>`  | Load a trusted extension from an absolute path (repeatable; cannot be combined with `--extension`/`-e`/`--hook`). |
| `--plugin-dir <dir>`              | Add a local plugin directory to discovery (repeatable).                                                           |
| `--no-extensions`                 | Disable extension discovery (explicit `-e` paths still work).                                                     |
| `--skills <globs>`                | Comma-separated glob patterns to filter [skills](./skills.md) (e.g. `git-*,docker`).                              |
| `--no-skills`                     | Disable skills discovery and loading.                                                                             |
| `--no-rules`                      | Disable rules discovery and loading. See [context files](./context-files.md).                                     |

#### System prompt

| Flag | Description |
| --- | --- |
| `--system-prompt <text\|file>` | Plain-text system prompt override (default: coding assistant prompt). See [system prompt customization](./system-prompt-customization.md). |
| `--system-prompt-template <path>` | Strictly read `<path>` as a Handlebars system-prompt template; mutually exclusive with `--system-prompt`. See [system prompt customization](./system-prompt-customization.md). |
| `--append-system-prompt <text\|file>` | Append plain text or file contents to the system prompt. |

#### Output mode

| Flag            | Description                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--mode <mode>` | Output/transport mode: `text` (default), `json`, `rpc`, `acp`, or `rpc-ui`. See [output modes](#output-modes---mode). |

#### Information

| Flag              | Description                                   |
| ----------------- | --------------------------------------------- |
| `--help`, `-h`    | Show help for `omp` or a subcommand and exit. |
| `--version`, `-v` | Print the installed version and exit.         |

### Headless / print mode

`--print` / `-p` runs `omp` non-interactively: it processes the prompt, streams
the result to stdout, and exits without entering the TUI. This is the entry point
for scripting and automation.

```sh
# Print the answer and exit
omp -p "Summarize the changes in the last commit"

# Include the model's thinking blocks in the printed text
omp -p --print-thoughts "Explain your reasoning for this refactor"

# Machine-readable output for pipelines
omp -p --mode json "List every TODO in src/" > todos.json

# Pipe a prompt via stdin
echo "review this diff" | omp -p
```

Related flags for headless runs:

- `--print-thoughts` — include thinking blocks in the printed text output.
- `--mode json` — emit structured events instead of rendered text.
- `--no-title` — skip title auto-generation (also `PI_NO_TITLE`).
- `--max-time <duration>` — bound the run.

The [advisor / watchdog](./advisor-watchdog.md#headless-runs) doc describes
print-mode disposal semantics when the advisor runtime is enabled.

### Output modes (`--mode`)

| Mode     | Description                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`   | Default. Rendered text output (TUI when interactive, plain text under `--print`).                                                                                 |
| `json`   | Structured JSON event stream, for headless/machine consumption.                                                                                                   |
| `rpc`    | JSON-RPC server over stdio. See [RPC](./rpc.md).                                                                                                                  |
| `rpc-ui` | RPC transport with UI extension events enabled.                                                                                                                   |
| `acp`    | Agent Client Protocol server over stdio. Equivalent to the [`acp`](#subcommands) subcommand; see [approval mode → ACP sessions](./approval-mode.md#acp-sessions). |

### Saved setup control center

In the interactive CLI, **Profiles** is embedded directly in `/settings`;
`/profiles` jumps to that same tab in the same Settings screen. Its flat left
sidebar uses the same native rows, two-space label indent, width, and single
vertical divider as the other Settings tabs. Actual setup emojis remain beside
their names without reserving a gutter for setups that have none. Filtering and
keyboard, mouse, and paging navigation are unchanged; selecting a setup previews
it without loading it. The emoji is a cosmetic label only: it does not change
the setup name, filename, search text, or identity. **Current setup** remains the
effective runtime configuration, not an alias for whichever saved setup was
loaded last.

The selected setup's name, current/saved identity, and read-only status stay
pinned at the top of the right profile pane beside the full-height setup list;
selecting a saved setup never activates it. The rest of the right pane is one
continuous, compact, read-only overview rather than a second settings editor.
**Models** comes first and keeps every assigned or resolved model row. Roles
with no assignment or resolution are summarized together on a wrapping line,
and an identical warning shared by several roles is shown once with every
affected role name. Wide model rows align role, model, thinking, intelligence,
performance, context, and cost columns. Narrow rows wrap the available facts,
retain meaningful zero or free values, and omit metric labels whose values are
unavailable.

**Agents** retains each assignment, enabled state, source, and thinking
configuration. On wide panes it sits beside the compact **Settings & memory**
summary; narrow panes stack those sections without dropping their content.
Current setup summarizes that the active session owns its settings. For saved
setups, **Settings & memory** preserves each optional group's **Included** or
**Inherited** ownership. Mandatory model-role assignments remain separate from
this membership list. The ten optional groups are **Model options**,
**Appearance**, **Interaction**, **Context**, **Memory**, **Files**,
**Shell**, **Tools**, **Agents & tasks**, and **Provider settings**; **Model
options** is optional just like the other groups. Inherited means **Use local
configuration**, not that the underlying feature is disabled. The compact
**Memory** summary describes portable memory behavior, not stored memories.
**Provider settings** likewise covers portable behavior, not authentication or
service endpoints. The overview does not enumerate individual effective scalar
setting values.

**Usage & limits** follows in the same scroll area and never extends beneath
the setup list. It keeps the complete provider, account, quota-window, and note
breakdown. Provider blocks use up to three columns when the right pane has
enough room, then reflow to fewer columns without dropping details. Account
sharing is attached to the applicable provider block rather than separated
from its limits. Confirmed, Possible, and Unknown sharing states remain
distinct, and account labels stay privacy-safe. Quota labels, percentages, and
native thin progress glyphs and spacing keep adjacent, independent windows
from appearing as one continuous bar.

The overview renders directly across the available right-pane width, using
native themed section headings. Tab and Shift+Tab move between only the
setup list and the overview. While the overview is focused, arrows, paging
keys, and the mouse wheel scroll continuously from Models and Agents through
Settings, Memory, and Usage. The pinned setup name and status remain visible
throughout. Narrow and wide terminal resizing reflows the same content without
making any section unreachable.

Only portable settings assigned to a group by the Settings schema are eligible.
**Agents & tasks** also owns saved disabled-agent and agent-model override
values. Included profiles use those saved values while Inherited profiles use
the local assignments; the compact preview reports the resulting agent facts,
not every owned setting.

Enter, Space, or `e` opens the selected Current or saved setup's complete
profile customization menu regardless of child focus. Editing model roles,
agents, groups, and their settings happens only in that isolated draft, never
in the preview.

Profiles do not create, clone, delete, or switch credential profiles; select a
credential profile at launch with `--profile`.

| Key             | Action                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Left / Right    | Switch the parent Settings tabs, including when the overview has focus.                                                                                   |
| Tab / Shift+Tab | Move between the setup list and the single scrollable overview.                                                                                         |
| Up / Down       | Select a setup or scroll the focused overview.                                                                                                           |
| Enter / Space   | Open the selected Current or saved setup in the complete profile editor from either focus.                                                               |
| `e`             | Open the selected Current or saved setup in the complete profile editor from either focus.                                                               |
| `l`             | Choose whether to apply the selected setup's models to this session or start a fresh session with the full saved setup.                                    |
| `s`             | Prepare the current setup as a new saved profile; the draft starts models-only.                                                                            |
| `i`             | Import an `omp-profile` or `omp-model-roles` artifact from the clipboard or a file, review compatibility, and save a new setup.                            |
| `x`             | Choose Profile or Model roles only, then export through the clipboard or a new file.                                                                       |
| `d`             | Delete the selected saved setup after confirmation; never deletes Current setup or credentials.                                                            |
| `n`             | Rename the selected saved setup without changing its emoji, settings, assignments, or the running session.                                                 |
| `m` / `a` / `,` | For Current setup, open the standard live model or agent controls, or switch to ordinary Settings. Model and agent controls return to the Settings parent. |
| `/`             | Search setup names; printable keys edit the search while focused.                                                                                          |
| PgUp / PgDn     | Page the setup list or the continuous overview for the current focus.                                                                                   |
| Esc             | Clear active search; otherwise return overview focus to the setup list, or close Settings from the setup list.                                        |

Mouse selection follows the same setup actions. Clicking anywhere in the
overview focuses its single scroll area, and the wheel continues from its
current offset even over lower Usage content. Pointer input to the left of the
overview remains in the full-height setup list, so clicking or wheeling there
selects or scrolls setups.
Profiles automatically rediscover and update after committed
profile changes and when you return from live model or agent controls or
another Settings tab; the dashboard does not poll continuously. Saved setup
inspection does not load it, and editor changes remain staged until an
explicit save. An immediate saved-profile emoji change is the only exception.

#### Editing and saving profiles

The profile editor is isolated from the active session and ordinary Settings
files. It presents the whole setup as one continuous native Settings list:
wide terminals show a section index, while narrow terminals use inline section
headings. The list covers the emoji, model roles, agents, optional groups, and
every eligible setting. Up and Down move between rows, Tab and Shift+Tab jump
between sections, and typing searches the list. Enter activates the selected
field or action; Space changes it when Space is not being entered as search
text. Only individual compound settings open nested native controls—groups do
not open separate Settings screens.

A new draft made from Current setup starts with models only, no emoji, and
every optional group OFF. An existing saved setup starts with its saved emoji,
enabled groups, and values. Fields belonging to an OFF group remain visible
and show their inherited eligible values, but are disabled. Turning that group
ON captures its currently inherited base values into the draft. Turning an ON
group OFF requires confirmation, then removes that group's owned paths from
the draft. None of these group or setting changes writes the profile file
until the whole draft is saved.

The emoji picker offers 29 curated choices and leads with labels such as
Coding, Research, Cloud, Automation, Mobile, and Favorite. Each original emoji
appears in a trailing column after a two-space gap, so terminal-specific emoji
widths cannot shift the label column; **None** removes the emoji. These labels
are user-chosen decoration, not inferred price, speed, quality, or offline
guarantees.

For an existing saved setup, the emoji field advertises its immediate-write
behavior: choosing an emoji with Enter or the mouse writes only that emoji to
the setup file, and choosing **None** removes it. Arrow-key navigation changes
only the picker preview. If the write fails, the previously saved emoji
remains intact and the picker stays open so the choice can be retried. Current
setup, new and unnamed drafts, and **Prepare profile export** keep emoji
choices staged until their explicit save or export action.

An enabled group owns only the paths actually saved in that profile, so
settings introduced by a later software update continue to inherit until
explicitly captured. A fresh session likewise inherits the recipient's
profile, workspace, and command-line configuration for every OFF group.
Choosing a model, agent, group, or setting in the draft does not change the
running session. By contrast, the Current setup shortcuts `m`, `a`, and `,`
open the existing live controls and retain their normal storage behavior.

Ctrl+S saves the complete draft through the existing confirmation and naming
flow. For a selected saved setup, confirmation atomically replaces that setup
file; it does not reapply the result to an already running session. **Save as
new** is create-only and asks for a different name rather than overwriting a
collision. Saving Current setup also creates a new profile. Esc closes an open
native Settings field or active search first; from the main editor it cancels
the remaining draft. Canceling an emoji, model, or agent picker also cancels
the whole remaining draft. Cancellation, validation errors, and aborted nested
controls leave the live session unchanged and do not write that draft. An
emoji already committed for an existing saved setup remains in the setup file.
If saving fails, the editor retains the draft and displays the error so you can
correct the destination and retry without re-entering changes.

Native setups live at
`<active agentDir>/setups/<name>.yml`. The reserved `$setup` metadata records
the metadata version, optional emoji, and enabled optional groups while the
settings remain a normal config overlay. Saved setup names preserve case,
spaces, and Unicode, such as `Work Profile`. Surrounding whitespace is trimmed;
names are limited to 64 characters and cannot contain path separators, control
characters, Windows-invalid filename characters, reserved device names, or a
trailing dot. `default` is a valid saved setup name; credential-profile names
remain a separate, stricter namespace. Saving selects the new setup, renaming
follows its new name, and deleting returns selection to Current setup without
changing the running session.

Metadata-less legacy setup files remain readable. Their enabled groups are
inferred only from values actually present, they have no emoji until edited,
and listing or previewing them does not rewrite the file. An explicit edit/save
writes canonical metadata while preserving unrelated legacy values. Local-only
legacy values are retained in the native setup; a full-profile export reports
the incompatible path instead of silently dropping it.

Saved setups preview their next launch in the current workspace; extension-only
models may be unavailable in this offline preview. Standard Settings edits are
live and persist through their normal profile/project storage choice, but they
do not rewrite a saved profile. Use the complete profile editor to capture or
change values owned by that profile.

Quota belongs to provider accounts, not setups. Shared accounts do not gain
extra capacity when used in multiple setups. **Usage & limits** in the
continuous overview keeps short and long windows separate, distinguishes
scoped caps from shared headroom, and does not present unsupported quota as an
available balance. Account-shared windows remain labeled as account quota;
tier/model caps appear separately. Unrelated caps and separate meters (such as
Codex chat versus Spark) are not combined. Multi-account shared capacity uses
account equivalents rather than an invented percentage. Missing reports remain
unavailable or not reported, cached stale data is marked, and refresh failures
retain last-good data with a stale/error label. Custom credential overrides may
use separate billing; the displayed values are reported account limits.

Loading a saved setup offers two choices:

- **Apply models to current session** transactionally applies model roles and
  thinking levels without replacing the session, conversation, or draft.
  Optional groups, agent overrides, the saved profile, and normal Settings
  files remain unchanged. Busy state, cancellation, unavailable assignments,
  or a model too small for the current conversation block application rather
  than silently substituting a model or compacting the conversation.
- **Start a new session** saves the old session and draft, then starts a fresh
  session in the same credential profile and workspace. It applies the
  mandatory models plus only the enabled groups' saved paths. OFF groups inherit
  the original profile/workspace/CLI layers. Each switch starts from those
  original config inputs plus the newly selected setup, so a generated setup
  overlay from a previous switch does not accumulate.

For a fresh-session load, persisted sessions get a profile-qualified resume
command. The original shell environment and workspace configuration still
apply; the new session does not carry the conversation or unrelated
session-only CLI overrides. Active work blocks loading. Cancellation, preflight
failure, rejection, and acknowledgement timeout leave the current session
running. Loss of supervisor IPC instead saves and shuts down the child to
prevent an orphaned interactive process.

Saved-setup inspection and loading require the OMP CLI launch context; SDK
hosts can still show and save the current setup.

#### Sharing profiles and model roles

Use Export (`x`) to choose an explicit scope. **Profile** (the default) includes
mandatory model roles, the optional emoji, and exactly the selected profile's
enabled groups and saved values. **Model roles only** deliberately omits the
emoji, optional settings, and agent overrides and retains the separate
`omp-model-roles` version 1 schema. After choosing the scope, choose **Copy to
clipboard** or **To file**. Clipboard access happens only after the explicit
clipboard action. File exports create a new file and never overwrite an
existing destination.

Exporting Current setup at Profile scope opens an isolated **Prepare profile
export** draft. Continuing exports that draft without saving a native setup or
changing the active session.

The full portable envelope is `omp-profile` version 1. For example:

```yaml
format: omp-profile
version: 1
name: "Focused work"
emoji: "💻"
includedGroups:
   - context
modelRoles:
   default: "anthropic/claude-sonnet-4-5:medium"
   smol: "@default:low"
settings:
   compaction:
      enabled: true
```

Models-only profiles use an empty `includedGroups` list and empty `settings`
mapping. The `name` is only a suggested setup name, never a destination path.
The roles-only v1 envelope instead contains exactly the fields
`format: omp-model-roles`, `version: 1`, and `modelRoles`.

Use Import (`i`) to choose **From clipboard** or **From file**. The validated
format identifier dispatches both transports through the same review and save
flow. Full-profile import restores exactly the artifact's enabled groups and
saved values; it does not opt in locally available settings.
Compatibility review uses each role's accepted model kinds and preserves
aliases to explicitly Automatic built-in roles. Excessive alias nesting or
expansion is flagged for review before resolution to keep the interface responsive.

The initial review is read-only and scrollable. Its labels and descriptions
show the suggested name and emoji, every ON/OFF group, saved and local values,
and model compatibility; local service availability is marked unverified.
**Continue** and **Cancel** stay pinned outside the review. Continue is focused
by default, so Enter advances; Ctrl+S also continues, Tab or Shift+Tab changes
button focus, Up/Down/PgUp/PgDn or the mouse wheel scrolls the review, and Esc
cancels.

Compatibility resolution covers model roles and enabled **Agents & tasks**
agent-model assignments, including ordered fallback entries and role
references. It distinguishes unconfigured providers, missing credentials,
missing models, pending discovery/selector review, and Automatic assignments.
A replacement can be applied to other unresolved assignments with the same
original selector without reordering fallback chains. Missing local agent
definitions require explicit removal; the importer neither creates agents nor
silently discards their overrides or disabled state. **Ready** means a selector
matches local configuration, not that a provider request or account access
succeeded.

After resolution, a final read-only review uses the same pinned Continue and
Cancel actions. Continuing asks for a validated setup name and creates a new
setup only; collisions never overwrite. Saving the import selects the setup but
does not activate it. Use `l` separately to apply models or start a fresh
session.

Supported OAuth providers offer the existing explicit login flow; other
provider setup uses the existing external configuration route. Recheck after
configuration. Cancelling discards draft profile changes but does not undo an
explicitly completed login.

Portable artifacts exclude credentials, account identities, account-credit
spending and redemption policies, provider/broker endpoints, machine paths and
executable configuration, conversation history, stored memory contents, and
other private local data. They include only values
actually saved under enabled portable groups, never a snapshot of all local
Settings. Both file and clipboard input are limited to 1 MiB; malformed or
unsupported versions, unexpected fields, unsafe structures, unknown groups,
and settings supplied for an OFF group are rejected without a partial save.
Empty or unreadable clipboard content likewise leaves setups unchanged and
shows a sanitized error.

## Subcommands

Run `omp <command> --help` for each command's own flags and examples.

| Command | Purpose | See also |
| --- | --- | --- |
| `launch` | Start a coding session (the default command). | [Launch flags](#launch-flags) |
| `acp` | Run Oh My Pi as an ACP (Agent Client Protocol) server over stdio. | [approval mode](./approval-mode.md#acp-sessions) |
| `auth-broker` | Manage the omp auth-broker (credential vault). | [auth broker / gateway](./auth-broker-gateway.md) |
| `auth-gateway` | Run an auth-gateway forward proxy backed by the configured broker. | [auth broker / gateway](./auth-broker-gateway.md) |
| `agents` | Manage bundled task agents. | [task agent discovery](./task-agent-discovery.md) |
| `bench` | Benchmark models: TTFT/prefill vs decode throughput with p50/p95 across chat, prefill, generation, and prompt-cache workloads, rendered in a live dashboard (`--prefill-bytes` sizes the synthetic prefill input). | |
| `browser-relay` | Run the local CDP relay used by Eval's browser API to drive your own Chrome tabs. | [computer use](./computer-use.md) |
| `cleanse` | Detect and fix project diagnostics with weighted parallel subagents. | |
| `commit` | Generate a commit message and update changelogs. | |
| `completions` | Print a shell completion script (bash, zsh, or fish). | |
| `compress` | Rewrite a text file into the dense prompt register, reporting what it drops. | |
| `config` | Manage configuration settings. | [config usage](./config-usage.md), [settings](./settings.md) |
| `dry-balance` | Dry-run OAuth account balancing across random session ids. | |
| `gc` | Run storage garbage collection. | |
| `grep` | Test the grep tool from the CLI. (The [`grep` tool](./tools/grep.md) is a separate agent tool.) | |
| `gallery` | Preview tool renderers across streaming, in-progress, success, and failure states. | |
| `git` | Interactive fullscreen git UI: split diff viewer, staging sidebar, and commit composer. | |
| `grievances` | View, clean, or push reported tool issues (auto-QA grievances). | |
| `if-bench` | Benchmark instruction following and working memory: one cached thread of glyph array actions with a cat-sound directive that moves through the prompt. | |
| `images`, `img` | Inspect, diagnose, probe, and purge image publication backends. | |
| `install` | Install or link an extension package (alias of `plugin install` / `plugin link`). | [extensions](./extensions.md) |
| `join` | Join a shared collab session (same as `/join`). | [collab](./collab.md) |
| `models` | List, search, and refresh available models. | [models](./models.md) |
| `plugin` | Manage plugins (install, uninstall, list, etc.). | [extensions](./extensions.md), [marketplace](./marketplace.md) |
| `ps` | List and control daemon-supervised background processes (logs, stop, kill, restart). | |
| `say` | Synthesize text with the local TTS engine and play it through the speakers. | [tts tool](./tools/tts.md) |
| `share` | Share a saved session via an encrypted link (same as the `/share` slash command). | [session operations](./session-operations-export-share-fork-resume.md) |
| `setup` | Run onboarding setup or install dependencies for optional features. | |
| `shell` | Interactive shell console. | |
| `read` | Show what the read tool will return for a path, URL, or internal URI. (The [`read` tool](./tools/read.md) is a separate agent tool.) | |
| `render` | Draw a session's entire thread through the production transcript pipeline (with repaint timing). | |
| `ssh` | Manage SSH host configurations. | |
| `stats` | View usage statistics. | |
| `update` | Check for and install updates; `--canary`/`--stable` switch release channels. | |
| `usage` | Show provider usage limits for every authenticated account; `usage clients` breaks token burn down per client (with `--days`), `usage invalidate` drops cached reports. | |
| `tiny-models` | Download tiny local models (session titles + memory). | [local models](./local-models.md) |
| `token` | Get the API key or OAuth token for a provider. | [secrets](./secrets.md) |
| `ttsr` | Inspect and test Time-Traveling Stream Rules (TTSR). (Covers the CLI command; the [TTSR feature](./ttsr-injection-lifecycle.md) is documented separately.) | |
| `worktree`, `wt` | List or clear agent-managed git worktrees (`~/.omp/wt`). | |
| `search`, `q`, `web-search` | Test web search providers from the CLI. | [web_search tool](./tools/web_search.md) |

> `install`, `join`, `browser-relay`, `auth-gateway`, and `tiny-models` are also
> reachable through related mechanisms (the `plugin` command, the `/join` slash
> command, and so on). The table lists each as it is registered in
> `packages/coding-agent/src/cli-commands.ts`.
