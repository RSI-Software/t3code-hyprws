# T3 Code - hyprws

I hate reading agent yap in a terminal.
T3 Code fixes that.
Love it.

I am also particular about how my workstation is laid out.
I do not want every project piled into one application window.

That feels like opening VS Code at `/` and putting every repository in one window.
Visual workspaces already solve that separation.

`hyprws` makes the T3 Code desktop app fit that model with native, project-scoped windows.
These are not separate T3 Code instances.
They share one Electron process, backend pool, authentication, providers, sessions, and persisted state.

## The layout

Each project gets an independently placeable T3 Code window alongside its editor, terminals, and browsers.
Hyprland and virtual desktops decide where those windows live.

```text
┌─ Workstation / Hyprland ───────────────────────────────────────────────────┐
│                                                                           │
│  Virtual desktop 1 · Project A                                            │
│  ┌─ Monitor 1 · WS 1 ─────────────────┐  ┌─ Monitor 2 · WS 2 ───────────┐ │
│  │ ┌────────────┐  ┌────────────────┐ │  │ ┌──────────────────────────┐ │ │
│  │ │ T3 Code    │  │ editor + zmux  │ │  │ │ browsers                 │ │ │
│  │ │ Project A  │  │ Project A      │ │  │ │ Project A                │ │ │
│  │ └────────────┘  └────────────────┘ │  │ └──────────────────────────┘ │ │
│  └────────────────────────────────────┘  └──────────────────────────────┘ │
│                                   ⇅                                       │
│  Virtual desktop 2 · Project B                                            │
│  ┌─ Monitor 1 · WS 3 ─────────────────┐  ┌─ Monitor 2 · WS 4 ───────────┐ │
│  │ ┌────────────┐  ┌────────────────┐ │  │ ┌──────────────────────────┐ │ │
│  │ │ T3 Code    │  │ editor + zmux  │ │  │ │ browsers                 │ │ │
│  │ │ Project B  │  │ Project B      │ │  │ │ Project B                │ │ │
│  │ └────────────┘  └────────────────┘ │  │ └──────────────────────────┘ │ │
│  └────────────────────────────────────┘  └──────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

My surrounding setup is opinionated too.
I use Hyprland workspaces, dual-monitor virtual desktops, `zmux`, and Worktrunk.

The fork does not encode that compositor policy.
It only provides the project windows that Hyprland can place.

## Why a fork?

`hyprws` now carries several independent domains.
Each one exists because upstream T3 Code does not currently provide the behavior.
Each one also has its own retirement condition.

Project-scoped windows were the first domain, but they are not necessarily permanent fork machinery.
A browser pointed at a self-hosted T3 backend already shares sessions, authentication, providers, and state.
Browser mode still trails Electron for terminal workflows and nested in-app browser windows.

If browser mode reaches practical parity, the project-window domain is superseded.
The same layout could use normal browser windows or a small PWA-style Electron shell around the web client.
Upstream-native project windows would supersede it too.

That would retire one domain, not necessarily the fork.
Custom agents, rich Markdown editing, `zmux` integration, distribution, and future domains stand on their own needs.

## What this fork adds

The fork is organized into domains so future changes do not become one untraceable patch pile.
Every fork commit is recorded by domain and tier in the [fork delta](docs/internals/fork-delta.md).

### Project windows

- Open a project window from hub actions, the command palette, or `Ctrl+Alt+O`.
- Give each window its own project-scoped routes, sidebar, drafts, and previews.
- Focus the existing window when the same project is opened again.
- Route second launches, renderer requests, and deep links to the correct window.
- Keep shared services shared: backend, authentication, providers, settings, sessions, and persisted state.

This domain can retire when the web client reaches practical Electron parity for this workflow.
Upstream-native project-window support would also replace it.

### Managed `zmux` estate

- Attach thread terminals to the checkout's managed `zmux` session.
- Bind new thread worktrees into the same session lifecycle.
- Keep terminal work visible from both T3 Code and the operator's CLI.

### Custom agents

- Discover provider-native Claude and Codex agents.
- Select a custom agent for the main thread from the composer.
- Persist the selection across new and resumed sessions.

### Rich Markdown editing

- Switch Markdown files between Rich and Source modes.
- Preserve CommonMark, GFM, and YAML frontmatter through the existing save path.
- Keep MDX in read-only preview where rich round-tripping would be unsafe.

### Workspace files

- Reveal gitignored agent artifacts in workspace file trees on demand.
- Keep ignored paths hidden by default and preserve the choice on the current device.
- Retain workspace containment unless a path is explicitly trusted.

### Fork maintenance and distribution

- Track why each fork domain exists, what it changes, and when it can be retired.
- Scan upstream changes against each active domain on every rebase.
- Run fork-specific CI and publish Linux AppImage releases as `v<upstream version>-hyprws.<n>`.

### Upstream fixes

The fork also carries focused fixes that are valid upstream but have not landed there yet.
Each stays isolated so it can be offered upstream and dropped from the fork independently.

The ledger separates `core`, `qol`, and `bugfix` commits.
It also records whether each bug fix should go upstream.
The [fork delta](docs/internals/fork-delta.md) owns the exact domain boundaries and current change list.

## Fork development

Read [Fork development](docs/internals/fork-development.md) before changing fork behavior or Git topology.
It owns the project-window architecture, Worktrunk lanes, and upstream rebase flow.

Read [Fork delta](docs/internals/fork-delta.md) for the authoritative list of fork changes and their rationale.
[Fork sync](docs/operations/fork-sync.md) is the runbook for rebasing, verifying, publishing, and releasing the fork.

# T3 Code

T3 Code is an "agent harness control surface".
It lets you control agents through mobile, web, and Electron desktop apps.

Clients: [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) · [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code) · [web](https://app.t3.codes) · [desktop](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode.
If they're set up on your computer, T3 Code can control them.

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
