# Codex

This guide is for people who want to use more than one Codex account in T3 Code.
For Claude, see [Claude](./providers-claude.md).
For first-time setup, see [Install T3 Code](./install.md).

Common reasons:

- use a work account for work projects
- use a personal account for personal projects
- switch to another account when one account hits limits
- keep one shared Codex history instead of maintaining two separate Codex setups

## I Only Use One Codex Account

Use the default provider.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

Log in with Codex normally:

```bash
codex login
```

## Choose A Codex Custom Agent

T3 Code reads personal Codex agents from `<CODEX_HOME>/agents/*.toml`.
The Agent picker appears beside the model when at least one valid agent is available.

Each file needs `name`, `description`, and `developer_instructions`.
Other Codex configuration keys form the selected agent's session layer.

```toml
name = "fable"
description = "Shape product direction"
developer_instructions = "Work from first principles."
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
```

Choose `Default` to start Codex without a custom main thread agent.
An agent's `model` and `model_reasoning_effort` override the adjacent model controls for that session.

Shadow homes share the main `CODEX_HOME` agent directory with their skills, plugins, and session history.
Refresh the provider status in Settings after syncing a new agent if it does not appear immediately.

## I Want Work And Personal Codex Accounts

Use one real Codex home and one shadow home.

Recommended setup:

```text
~/.codex      shared Codex home
~/.codex_p    second account auth
```

The idea is:

- both accounts can see the same T3/Codex sessions
- each account keeps its own login
- existing threads can continue with either account

### Set Up The First Account

Log in normally:

```bash
codex login
```

This is the account used by `~/.codex`.

In T3 Code Settings, name it something obvious:

```text
Display name: Codex Work
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

### Set Up The Second Account

Log in with a separate Codex home:

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

In T3 Code Settings, add another Codex provider:

```text
Display name: Codex Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

Both providers must use the same `CODEX_HOME path`.
Only the second provider has a `Shadow home path`.

## Which Account Am I Using?

Open Settings and look at the provider row.

T3 Code shows the authenticated email for providers that report one.
Emails are blurred by default; click the blurred email to reveal it.

Use display names and accent colors to make accounts easy to tell apart in the model picker.

## I Need A Different API Key Or Endpoint

Use the provider's Environment variables section in Settings.

Use this section when a Codex-compatible setup needs account-specific variables.
Add them to the provider instance that should receive them.
Mark API keys or tokens as sensitive.

Sensitive values are server secrets and are not returned to the app after saving.

## Can I Switch Accounts In An Existing Thread?

Yes, when both Codex providers share the same `CODEX_HOME path`.

For example:

```text
Codex Work      CODEX_HOME path: ~/.codex
Codex Personal  CODEX_HOME path: ~/.codex, Shadow home path: ~/.codex_p
```

Those providers are compatible for continuation.
The locked model picker can therefore show both.

A provider with a different `CODEX_HOME path` belongs to a different workspace.
It is not offered for existing threads created under `~/.codex`.

## If Both Accounts Look The Same

If two Codex providers show the same account or the same unexpected model list:

1. Check the email in Settings.
2. Refresh provider status.
3. Confirm the second provider has `Shadow home path` set.
4. Confirm the shadow directory has its own `auth.json`.
5. If you copied `~/.codex` into the shadow directory, remove everything except `auth.json`.

Example cleanup:

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## When To Use A Separate CODEX_HOME

Use a totally separate `CODEX_HOME path` only when you want a separate Codex workspace.

This creates separate sessions and reduces account switching inside old threads.
Most dual-account users should use the shared-home plus shadow-home setup instead.
