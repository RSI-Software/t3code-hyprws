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

- **Only selected** shows chosen projects
- **All except selected** also picks up new ones
- **No selection** shows every project
- **Open threads stay** when the filter narrows
- **Both windows stay live** on one thread
- **Windows return** to their workspaces on update
- **Old `#/project/...` links** still open

**One window per project, one backend**

https://github.com/user-attachments/assets/33164357-eb9c-4778-b0b7-6a0a2c9a04d6

<details>
<summary>More clips</summary>

**Choose projects, exclude them, or reset to all**

https://github.com/user-attachments/assets/b5bee2e8-1432-4a9d-8e3b-c9eddd3f2b5c

**One thread in two windows, streaming in both**

https://github.com/user-attachments/assets/4295662d-e021-4296-9ee4-7c0c4c736987

</details>

## What else the fork adds

Every fork commit belongs to one domain, and each domain retires when upstream covers it.
The [fork delta](docs/fork/internals/fork-delta.md) owns the full list.

### Custom agents

- **Discovers** native Claude and Codex agents
- **One runs** as the main thread
- **Persists** across new and resumed sessions

https://github.com/user-attachments/assets/29c94d1c-cbf2-477f-b4ea-52193ccc5b5a

<details>
<summary>More clips</summary>

**The project agent behind it: `.claude/agents/pirate.md`**

https://github.com/user-attachments/assets/78f1f4b6-1162-4498-b5ca-95542e40f15f

</details>

### Remote voice models

- **Any OpenAI-compatible** transcription service
- Shows as a **model under Transcription**
- **Live preview** over OpenAI Realtime
- **Ducks speakers** while recording on desktop
- Set up in **Settings → Voice → Remote model**

### Rich Markdown editing

- **Rich and Source** modes for Markdown files
- **Saves CommonMark**, GFM, frontmatter intact
- **MDX** stays a read-only preview
- [Guide](docs/fork/user/markdown-editing.md)

https://github.com/user-attachments/assets/f3b4c546-8c33-4f11-97bc-1c2eff67d195

<details>
<summary>More clips</summary>

**Rich and Source views of an existing file**

https://github.com/user-attachments/assets/4dc25fb0-3ed7-4cc2-9eee-d5b34eb3cd57

</details>

### Managed `zmux` terminals

- **Terminals join** the checkout's session
- **New worktrees join** the same session
- **Shared** between T3 Code and the CLI
- **Pick zmux or plain** in Settings → Terminal
- [Guide](docs/fork/user/managed-terminals.md)

https://github.com/user-attachments/assets/3fa4a68f-a189-4ca8-98d5-416e8c9eb4fd

<details>
<summary>More clips</summary>

**Open a plain shell alongside managed `zmux`**

https://github.com/user-attachments/assets/283f3ee9-a2f5-4f8a-821f-7d67d0994064

</details>

### Worktrunk worktrees

- **New worktrunk** mode for a thread
- **`wt` hooks run** on create and remove
- **`pre-start` writes** `.env.local` in the clip
- **Plain worktrees** without `wt`

https://github.com/user-attachments/assets/1758bb95-19f6-4ed1-a8d8-56366444f62f

<details>
<summary>More clips</summary>

**Removal runs `pre-remove`**

https://github.com/user-attachments/assets/0dfb8ebb-2145-4a81-92b5-d9c3b3a02a16

</details>

### GitHub issues

- **Browse issues** on web and desktop
- **Filters, comments**, and tabs in detail
- **Hand off** an issue to a new thread as a draft
- **Issues and threads link** both ways

https://github.com/user-attachments/assets/9d21df4b-8a5f-425e-9a59-2de67b2e7520

<details>
<summary>Linked threads</summary>

![An issue lists its linked thread](https://github.com/user-attachments/assets/39af8559-f194-4ae6-bba2-e6e8d9cd6a2d)

</details>

### Threads

- **Drag a thread** under another to group
- **Each group names** its shared subject
- **The parent leads**; its title is a tab
- **A working parent** carries the group
- **One group spans** several projects
- **Agents group threads** through MCP tools
- **Fork a thread** on the same provider

https://github.com/user-attachments/assets/dfb1fa2f-1d93-4bfa-bc83-c1d36261a9f1

<details>
<summary>More clips</summary>

**A working parent carries its group to Working**

https://github.com/user-attachments/assets/93618826-3a1d-4c86-bc89-3202b406af39

</details>

### Delegated follow-up rounds

- **The same child** keeps its context
- **Each round wakes** the parent
- **Track or cancel** the current round

**Two rounds, one child: typing 8×, work 6×**

https://github.com/user-attachments/assets/ac99f00f-f561-4b8e-b1c6-403708464b54

### Browser bookmarks

- **Global and per-project** collections
- **Star** to save, move, or remove a page
- **New tabs list** bookmarks first
- [Guide](docs/fork/user/browser.md)

https://github.com/user-attachments/assets/0992bf8a-37c7-425b-992c-5d08c61cc22e

### Workspace files

- **Reveal** gitignored agent artifacts on demand
- **Hidden by default**, remembered per device
- **Containment holds** unless trusted
- [Guide](docs/fork/user/workspace-files.md)

https://github.com/user-attachments/assets/46931a1e-d0f3-41d2-bf61-8fb79db19713

### Thread artifacts

- **Agents link** trackers, plans, and notes
- **Previews follow** each edit
- **Any host path**, scratch included
- **T3 never creates** or deletes the files
- [Guide](docs/fork/user/thread-artifacts.md)

https://github.com/user-attachments/assets/39efca0a-eeed-45c0-8f4a-8076da05dfc5

<details>
<summary>More clips</summary>

**A linked HTML tracker open beside its thread**

![A linked HTML tracker open beside its thread](https://github.com/user-attachments/assets/82265826-4ea8-42d6-a6bb-611c787c9e38)

</details>

### Collaborator sharing

- **Share a thread** to a collaborator's own app
- **Pairs with your server**, no T3 Connect
- **Change access live**, no new link
- **Messages carry** their name
- **You approve** each message by default
- [Guide](docs/fork/user/collaborator-sharing.md)

**Host left, collaborator on a separate VM right**

https://github.com/user-attachments/assets/a1746504-9151-470c-90e2-80a01e617e70

### Device approval and external agents

- **RFC 8628-style** device flow
- **The host approves** with `t3 auth device approve`
- **The token never passes** through a person
- **Outside agents** create and steer threads over MCP
- **Limited** to selected projects; revocable

**A client on another machine starts a T3 thread**

https://github.com/user-attachments/assets/c10b2b05-a493-4ada-b7b2-c52420ed8611

<details>
<summary>More clips</summary>

**An external MCP client answers an agent's question**

https://github.com/user-attachments/assets/442458b8-dfc8-4bb4-8f99-40207fab03f1

</details>

### Releases and upstream fixes

- **Linux AppImage** releases
- **Nightly** on every trunk push
- **Focused fixes**, dropped once upstream lands
- [Guide](docs/fork/user/install-and-update.md)

## Why a fork?

Upstream has no multi-window concept at all.
A browser on a self-hosted backend comes close, but still trails Electron for terminals and nested browser windows.
At parity, the window domains retire; the others stand on their own.

## Fork development

**Change fork code** with [Fork development](docs/fork/internals/fork-development.md).
**Every domain** and its retirement live in the [Fork delta](docs/fork/internals/fork-delta.md).
**Rebase and release** follow [Fork sync](docs/fork/operations/fork-sync.md).

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
