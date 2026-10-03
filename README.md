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

<p align="center">
  <a href="https://t3.codes">
    <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Code logo" />
  </a>
</p>

<h1 align="center">T3 Code</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://t3.codes/download"><strong>Download</strong></a> ·
  <a href="https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824">iOS</a> ·
  <a href="https://play.google.com/store/apps/details?id=com.t3tools.t3code">Android</a> ·
  <a href="https://app.t3.codes">Web</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://discord.gg/jn4EGJjrvv">Discord</a>
</p>

<p align="center">
  <a href="https://t3.codes">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Browser bookmarks](./docs/user/browser.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)
