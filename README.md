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
- **Same thread:** **Open in New Window**, both live
- **Update:** back on their Hyprland workspaces
- **Old links:** `#/project/...` links still open

https://github.com/user-attachments/assets/13204279-65d2-4599-b111-9c5043ca98fd

<details>
<summary>More clips</summary>

**One thread in two windows, streaming in both**

https://github.com/user-attachments/assets/61675d70-4b33-4337-b322-d7c86a20c2c7

**Relaunch: windows return to their workspaces**

https://github.com/user-attachments/assets/426db6b1-9a38-4719-9911-6d3bcb4a017b

</details>

## What else the fork adds

Every fork commit belongs to one domain, and each domain retires when upstream covers it.
The [fork delta](docs/fork/internals/fork-delta.md) owns the full list and boundaries.

### Custom agents

- **Discover:** native Claude and Codex agents
- **Select:** one as the main thread
- **Persist:** across new and resumed sessions

https://github.com/user-attachments/assets/29c94d1c-cbf2-477f-b4ea-52193ccc5b5a

<details>
<summary>More clips</summary>

**The project agent behind it: `.claude/agents/pirate.md`**

https://github.com/user-attachments/assets/78f1f4b6-1162-4498-b5ca-95542e40f15f

</details>

### Rich Markdown editing

- **Modes:** Rich and Source for Markdown files
- **Save:** CommonMark, GFM, frontmatter intact
- **MDX:** stays a read-only preview
- [Guide](docs/fork/user/markdown-editing.md)

https://github.com/user-attachments/assets/f3b4c546-8c33-4f11-97bc-1c2eff67d195

<details>
<summary>More clips</summary>

**Rich and Source views of an existing file**

https://github.com/user-attachments/assets/4dc25fb0-3ed7-4cc2-9eee-d5b34eb3cd57

</details>

### Managed `zmux` terminals

- **Attach:** terminals join the checkout session
- **Worktrees:** new ones join the same session
- **Shared:** visible from T3 Code and the CLI
- **Enable:** **Terminal session** in Appearance
- [Guide](docs/fork/user/managed-terminals.md)

https://github.com/user-attachments/assets/3fa4a68f-a189-4ca8-98d5-416e8c9eb4fd

### Worktrunk worktrees

- **Mode:** **New worktrunk** for a thread
- **Hooks:** `wt` hooks on create and remove
- **Proof:** `pre-start` writes `.env.local`
- **Fallback:** plain worktrees without `wt`

https://github.com/user-attachments/assets/1758bb95-19f6-4ed1-a8d8-56366444f62f

<details>
<summary>More clips</summary>

**Removal runs `pre-remove`**

https://github.com/user-attachments/assets/0dfb8ebb-2145-4a81-92b5-d9c3b3a02a16

</details>

### GitHub issues

- **Browse:** issues on web and desktop
- **Detail:** filters, comments, and tabs
- **Hand off:** one issue to a new thread as a draft

https://github.com/user-attachments/assets/9d21df4b-8a5f-425e-9a59-2de67b2e7520

### Threads

- **Group:** related active threads in the sidebar
- **Fork:** continue a copy on the same provider

https://github.com/user-attachments/assets/532802d4-4ddc-473e-b337-4f2c5906d3f8

### Browser bookmarks

- **Collections:** global and per project
- **Star:** save, move, or remove a page
- **New tab:** bookmarks listed first
- [Guide](docs/fork/user/browser.md)

https://github.com/user-attachments/assets/0992bf8a-37c7-425b-992c-5d08c61cc22e

### Workspace files

- **Reveal:** gitignored agent artifacts on demand
- **Default:** hidden, remembered per device
- **Safety:** containment holds unless trusted
- [Guide](docs/fork/user/workspace-files.md)

https://github.com/user-attachments/assets/46931a1e-d0f3-41d2-bf61-8fb79db19713

### Device approval

- **Grant:** RFC 8628-style device flow
- **Approve:** on the host, `t3 auth device approve`
- **Token:** never passes through a person

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
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Browser bookmarks](./docs/fork/user/browser.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
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
