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

### Custom agents

- **Discover:** native Claude and Codex agents
- **Select:** one as the main thread
- **Persist:** across new and resumed sessions

### Rich Markdown editing

- **Modes:** Rich and Source for Markdown files
- **Save:** CommonMark, GFM, frontmatter intact
- **MDX:** stays a read-only preview
- [Guide](docs/fork/user/markdown-editing.md)

### Managed `zmux` terminals

- **Attach:** terminals join the checkout session
- **Worktrees:** new ones join the same session
- **Shared:** visible from T3 Code and the CLI
- [Guide](docs/fork/user/managed-terminals.md)

### Worktrunk worktrees

- **Mode:** **New worktrunk** for a thread
- **Hooks:** `wt` hooks on create and remove
- **Fallback:** plain worktrees without `wt`

### GitHub issues

- **Browse:** issues on web and desktop
- **Detail:** filters, comments, and tabs
- **Hand off:** one issue to a new thread as a draft

### Threads

- **Group:** related active threads in the sidebar
- **Fork:** continue a copy on the same provider

### Browser bookmarks

- **Collections:** global and per project
- **Star:** save, move, or remove a page
- **New tab:** bookmarks listed first
- [Guide](docs/fork/user/browser.md)

### Workspace files

- **Reveal:** gitignored agent artifacts on demand
- **Default:** hidden, remembered per device
- **Safety:** containment holds unless trusted
- [Guide](docs/fork/user/workspace-files.md)

### Backend attach

- **Attach:** desktop joins a running backend
- **Pair:** automatically, once per launch
- **State:** one writer on `state.sqlite`, not two

### Releases and upstream fixes

- **Builds:** Linux AppImage releases
- **Nightly:** cut on every trunk push
- **Fixes:** focused, dropped once upstream lands
- [Guide](docs/fork/user/install-and-update.md)

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
- [Browser bookmarks](./docs/fork/user/browser.md)
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
