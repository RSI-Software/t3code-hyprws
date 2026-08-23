# Claude

This guide is for people who want to use more than one Claude setup in T3 Code.
For Codex, see [Codex](./providers-codex.md).
For first-time setup, see [Install T3 Code](./install.md).

Common reasons:

- use separate work and personal Claude accounts
- try a different Claude Code configuration without disturbing your main setup
- run Claude through a router such as Claude Code Router
- use external providers exposed through a Claude-compatible workflow

## I Only Use One Claude Account

Use the default provider.

Log in with Claude Code normally:

```bash
claude auth login
```

In T3 Code Settings, your Claude provider can stay like this:

```text
Display name: Claude
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

An empty `CLAUDE_CONFIG_DIR path` means T3 Code uses Claude Code's normal config directory.

When set, this field passes the directory through `CLAUDE_CONFIG_DIR`.
It does not change `HOME`, the system keychain, or the rest of the environment.

## Where Claude Skills Are Loaded

T3 Code checks these locations for Claude skills, in order:

1. The Claude config directory's `skills` folder.
2. `<workspace>/.agents/skills`.
3. `<workspace>/.claude/skills`.

If the same skill name exists in more than one folder, the later folder wins.

## Choose A Claude Custom Agent

T3 Code shows an Agent picker beside the model when Claude Code reports one or more custom agents.
Choose an agent before the first message to run it as the main thread agent.

For example, choosing `fable` has the same launch behavior as this command:

```bash
claude --agent fable
```

Choose `Default` to start Claude without a custom main thread agent.
The selection is saved with the thread and restored when T3 Code resumes the provider session.

Agent discovery uses the selected provider's Claude config directory and Claude Code setting sources.
Refresh the provider status in Settings after syncing a new agent if it does not appear immediately.

## I Want Work And Personal Claude Accounts

Use a different Claude config directory for each account.

Example:

```text
default config dir           work account
~/.claude_personal_home      personal account
```

### Set Up The First Account

Log in normally:

```bash
claude auth login
```

In T3 Code Settings:

```text
Display name: Claude Work
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

### Set Up The Second Account

Log in with a separate config directory:

```bash
mkdir -p ~/.claude_personal_home
CLAUDE_CONFIG_DIR=~/.claude_personal_home claude auth login
```

Use `CLAUDE_CONFIG_DIR`, not `HOME`.
Setting `HOME` writes the login to `~/.claude_personal_home/.claude`.
T3 Code does not look there.

Then add another Claude provider in T3 Code:

```text
Display name: Claude Personal
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_personal_home
```

Use the email in Settings to confirm each provider uses the intended account.
Emails are blurred by default; click the blurred email to reveal it.

## Can I Switch Claude Accounts In An Existing Thread?

Usually, no.

T3 Code only offers providers from the same Claude config directory for an existing thread.
A different config directory is a different Claude environment.

This differs from the recommended Codex setup.
Claude Code keeps account and local state across several files in its config directory.
T3 Code therefore keeps separate Claude config directories isolated.

## I Want To Use OpenRouter

Use this when you want Claude Code to talk to OpenRouter directly, without running a local router.
This is the simplest external-provider setup.

OpenRouter integrates with Claude Code through Anthropic-compatible environment variables.

### Configure A Claude OpenRouter Provider

Add or edit a Claude provider in T3 Code Settings:

```text
Display name: Claude OpenRouter
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_openrouter_home
```

In that provider's Environment variables section, add:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive.
T3 Code stores it as a server secret and does not return it to the app after saving.

If you want this setup isolated from your normal Claude account, create that home first:

```bash
mkdir -p ~/.claude_openrouter_home
```

If this Claude home has an Anthropic login, run `/logout` in a session for that home.
Do this before using OpenRouter.
Otherwise Claude Code may use cached Anthropic credentials instead of the OpenRouter token.

### Pick OpenRouter Models

OpenRouter can route Claude Code's default model roles to OpenRouter model IDs.

Example:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

Add those to the same provider's Environment variables section if you want stable model choices.

### Verify OpenRouter Is Being Used

Open a Claude session and run:

```text
/status
```

You should see the Anthropic base URL set to:

```text
https://openrouter.ai/api
```

You can also check the OpenRouter activity dashboard for requests from your API key.

### Common OpenRouter Mistakes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
- Set `ANTHROPIC_AUTH_TOKEN` to your OpenRouter API key.
- Set `ANTHROPIC_API_KEY` to an empty string so Claude Code does not try to use an Anthropic login.
- Put these variables on the Claude provider instance, not in global shell startup files.

OpenRouter's setup can change over time.
Use its upstream Claude Code guide for the current details:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## I Want To Use Claude Code Router

Claude Code Router provides a local routing layer with more control than a direct OpenRouter setup.

T3 Code does not need a special Claude Code Router provider.
Treat the router as a Claude environment with its own `CLAUDE_CONFIG_DIR path`.
Add the router's variables to that provider's Environment variables section.

Mark tokens and API keys as sensitive.

```text
Display name: Claude Router
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_router_home
```

Follow the upstream README for router setup:
<https://github.com/musistudio/claude-code-router>.

## I Want Different Claude Settings, Not A Different Account

Create another Claude provider with the same account if you want a named preset.

Examples:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

Give the preset a different `CLAUDE_CONFIG_DIR path` when it needs different Claude files.
Use Environment variables for different API keys, base URLs, or router settings.

Do not put environment variable assignments in `Launch arguments`.
