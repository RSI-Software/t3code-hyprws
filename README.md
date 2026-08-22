# T3 Code - hyprws

I hate reading agent yap output in a terminal; t3code solves this! Love it.

But I am very perticular on a conceptual level about how things aught to be laid out on my workstation. I do not like having one instance to handle every project.

To me this is like having one instance of VSCode at your root dir. \
EVERY REPO in one window; all in one place. No, this is what visual workspaces are for.

- Mulitple Instances (one per project/lane)
- Use hypland workspaces (+virtual desktops for dual monitor)
- zmux (opinioned tmux, think tmux+herdr but worse) for managing terminal stuff
- worktrees via worktrunk

```text
┌─ Project A · Virtual Desktop 1 ─────────────────────────────────────┐
│                                                                     │
│  ┌─ Screen 1 · Hyprland WS 1 ─────┐  ┌─ Screen 2 · Hyprland WS 2 ─┐ │
│  │                 │ [ VS Code ]  │  │                            │ │
│  │ [ t3code]       │   [ Zed ]    │  │       [ Browser(s) ]       │ │
│  │                 │ [ Milkcar ]  │  │                            │ │
│  └────────────────────────────────┘  └────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

┌─ Project B · Virtual Desktop 2 ─────────────────────────────────────┐
│                                                                     │
│  ┌─ Screen 1 · Hyprland WS 3 ─────┐  ┌─ Screen 2 · Hyprland WS 4 ─┐ │
│  │                 │ [ VS Code ]  │  │                            │ │
│  │ [ t3code]       │   [ Zed ]    │  │       [ Browser(s) ]       │ │
│  │                 │ [ Milkcar ]  │  │                            │ │
│  └────────────────────────────────┘  └────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘

┌─ Project C · Virtual Desktop 3 ─────────────────────────────────────┐
│                                                                     │
│  ┌─ Screen 1 · Hyprland WS 5 ─────┐  ┌─ Screen 2 · Hyprland WS 6 ─┐ │
│  │                 │ [ VS Code ]  │  │                            │ │
│  │ [ t3code]       │   [ Zed ]    │  │       [ Browser(s) ]       │ │
│  │                 │ [ Milkcar ]  │  │                            │ │
│  └────────────────────────────────┘  └────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## Fork development

Here, an instance means an independently placeable project window.
Project windows share one Electron process and the existing backend pool.

Read [Fork development](docs/internals/fork-development.md) before changing the fork.
It owns the product direction, architecture boundaries, Worktrunk lanes, and upstream rebase flow.

Read [Fork delta](docs/internals/fork-delta.md) to see what the fork actually changes and why.
It splits every change by domain and tier, and records what upstream would have to ship for each domain to be deleted.

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

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
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

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
