# T3 Code - hyprws

I hate reading agent yap in a terminal.
T3 Code fixes that.
Love it.

I am also particular about how my workstation is laid out.
One app window holding every project feels like opening VS Code at `/`.
Visual workspaces already solve that separation.

Upstream T3 Code is one window.
`hyprws` allows for multiple windows, and you can set them up however you like!
Select one (or more) projects in each window; Hyprland decides where it lives.
They are not separate instances: every window shares one Electron process, backend, auth, providers, and state.

```text
┌─ Virtual desktop 1 ──────────┐   ┌─ Virtual desktop 2 ──────────┐
│ T3 Code · Project A          │   │ T3 Code · Projects B, C      │
│ editor + zmux · browsers     │   │ editor + zmux · browsers     │
└──────────────────────────────┘   └──────────────────────────────┘
               └──────── one backend, one state ────────┘
```

My setup around it is opinionated: Hyprland, dual-monitor virtual desktops, `zmux`, and Worktrunk.
The fork encodes none of that policy.

## Multiple windows

| Key           | Does                                           |
| ------------- | ---------------------------------------------- |
| `mod+shift+w` | New window on all projects                     |
| `mod+alt+f`   | Choose this window's projects                  |
| `mod+alt+o`   | Reuse a window showing this project, else open |

- **Filter:** narrows lists, never hides live work
- **Update:** back on their Hyprland workspaces
- **Old links:** `#/project/...` links still open

## What else the fork adds

Every fork commit belongs to one domain, and each domain retires when upstream covers it.
The [fork delta](docs/fork/internals/fork-delta.md) owns the full list and boundaries.

| Domain           | Adds                                          |
| ---------------- | --------------------------------------------- |
| Custom agents    | A provider-native agent as the main thread    |
| Markdown editing | Rich editing that still saves Markdown        |
| `zmux` estate    | Thread terminals and worktrees in `zmux`      |
| Worktrunk hooks  | `wt` hooks on worktree create and remove      |
| Backend attach   | Desktop attaches to a running backend service |
| Workspace files  | Gitignored agent artifacts, shown on demand   |
| GitHub issues    | Browse issues and hand one to a thread        |
| Browser          | Durable bookmarks per project and profile     |
| Threads          | Manual grouping and same-provider forking     |
| Distribution     | Linux AppImage releases and an update feed    |
| Upstream fixes   | Focused fixes that drop once upstream lands   |

## Why a fork?

Upstream has no multi-window concept at all.
A browser on a self-hosted backend comes close, but still trails Electron for terminals and nested browser windows.
At parity, the window domains retire; the others stand on their own.

## Fork development

| Doc                                                         | Read it for                            |
| ----------------------------------------------------------- | -------------------------------------- |
| [Fork development](docs/fork/internals/fork-development.md) | Changing fork behavior or Git topology |
| [Fork delta](docs/fork/internals/fork-delta.md)             | Every fork change and why              |
| [Fork sync](docs/fork/operations/fork-sync.md)              | Rebase, verify, publish, release       |

# T3 Code

T3 Code is an "agent harness control surface".
It lets you control agents through mobile, web, and Electron desktop apps.

Clients: [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) · [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code) · [web](https://app.t3.codes) · [desktop](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity.
If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Inspect subagents](./docs/fork/user/agents.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Browser bookmarks](./docs/fork/user/browser.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
