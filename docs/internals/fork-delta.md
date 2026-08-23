# Fork delta

> Fork-only inventory for `RSI-Software/t3code-hyprws`.

[Fork development](./fork-development.md) owns discipline: branch topology, rebase rules, and commit hygiene.
This document owns the inventory: each change, its owning domain, and what would let us delete it.

Read this first when deciding whether a change belongs in the fork at all.

The commit list itself is generated, because commit hashes rot on every rebase.

```bash
vp run fork:delta           # Markdown ledger grouped by domain and tier
vp run fork:delta --check   # exit 1 when a fork commit lacks a valid trailer
vp run fork:delta --json    # the same ledger for tooling
```

It reads `upstream/main..HEAD` by default; pass `--base` and `--head` to inventory another range.

## Why the fork exists

Upstream's desktop app is single-window by construction.
`DesktopWindow` exposes only `createMain`, `ensureMain`, and `revealOrCreateMain`.
There is no window registry and no per-window scope.

Electron holds a single-instance lock.
A second launch forwards its arguments to the first window instead of opening another.

That is one global dashboard for every project.
The fork's premise is that a project window is the unit of desktop organization, one per Hyprland workspace.

### The upstream-supported alternative

Point a browser at the same backend and open one project per tab.
Sessions, auth, and state are shared because it is the same server.

That alternative is real, and it costs nothing.
It loses the in-app browser preview because that preview is desktop-only.
`apps/web/src/components/preview/previewBridge.ts` resolves to `null` without an Electron host.

The fork exists because of that gap and because native windows tile under Hyprland while browser tabs do not.
Close the gap upstream and the fork's core reason to exist closes with it.

## Tiers

Every fork change carries one tier.

| Tier     | Meaning                                            | On retirement                      |
| -------- | -------------------------------------------------- | ---------------------------------- |
| `core`   | The domain does not work without it.               | Deleted with the domain.           |
| `qol`    | Polish. Drop it and the domain still works.        | Reassess individually.             |
| `bugfix` | A defect fix. Note whether upstream reproduces it. | Upstream it, or keep if fork-only. |

A `bugfix` that upstream reproduces is an upstreaming candidate, not fork delta we want to carry.
Send it upstream as its own pull request and drop it from the stack when it lands.

## Trailers

Every fork commit carries `Fork-Domain` and `Fork-Tier`.
A `bugfix` also carries `Fork-Upstreamable`, so the ledger can tell an upstreaming candidate from a fork-only fix.

```text
feat(desktop): register windows by identity

Fork-Domain: project-windows
Fork-Tier: core
```

```text
fix(web): stop new threads waiting on an unreachable project file

Fork-Domain: project-windows
Fork-Tier: bugfix
Fork-Upstreamable: yes
```

| Trailer             | Values                        | Required on       |
| ------------------- | ----------------------------- | ----------------- |
| `Fork-Domain`       | A domain from the index below | Every fork commit |
| `Fork-Tier`         | `core`, `qol`, `bugfix`       | Every fork commit |
| `Fork-Upstreamable` | `yes`, `no`                   | Every `bugfix`    |

`vp run fork:delta --check` enforces the table, and fork CI runs it on every push.
On a pull request, fork CI also runs `vp run fork:delta --check --squash-body <file>` against the pull-request body, because that body becomes the squash commit's message; a body that does not end with the trailer block fails the required check before it can land untagged.
A rebase preserves trailers, so the log stays queryable after every sync.

## Domain index

| Domain                                | Status | Tiers present     | Retires when                                              |
| ------------------------------------- | ------ | ----------------- | --------------------------------------------------------- |
| [project-windows](#project-windows)   | Active | core, qol, bugfix | Web preview parity, or upstream multi-window.             |
| [custom-agents](#custom-agents)       | Active | core              | Upstream main-thread custom-agent selection.              |
| [markdown-editing](#markdown-editing) | Active | core              | Upstream ships safe rich Markdown editing.                |
| [fork-meta](#fork-meta)               | Active | qol               | Never. It documents the fork itself.                      |
| [distribution](#distribution)         | Active | core              | Never, while the fork ships its own builds.               |
| [upstream-fixes](#upstream-fixes)     | Active | bugfix            | Each commit, when upstream ships the fix.                 |
| [zmux-estate](#zmux-estate)           | Active | core              | Upstream terminals attach to an external session manager. |

Add a row per domain.
A domain is a reason the fork exists, not a feature area of the app.

## project-windows

### Need

One T3 Code window per project, placeable on its own Hyprland workspace.
It sits beside that project's editor, terminals, and browser.
The hub stays as the all-projects view; it stops being the only view.

### Shape

The core is a project route subtree, a scoped project shell, and a desktop window registry keyed by identity.

Launch intents reach the right window through the single-instance lock and hash routes.
Previews, composer drafts, and preview IPC are namespaced per window.

Entry points are the hub project actions, the command palette, a keybinding, and renderer IPC.
All of them gate on `window.desktopBridge.openProjectWindow`, so the web client is unchanged without the bridge.

QoL covers a retry when a scoped draft fails to start, `T3CODE_DESKTOP_DEVTOOLS=0`, and route test naming.
Two bugfixes reproduce upstream and should be offered there; the rest are fork-only.

An auto-update relaunch is one of those fork-only defects.
`quitAndInstall` destroys every window and comes back with no arguments, which is correct upstream because there is one window to come back to.
Here it collapses a workspace-per-project layout into a single hub window.
`apps/desktop/src/window/DesktopWindowSession.ts` writes a one-shot manifest of the open windows just before the install tears them down, and the next launch consumes it before `openArguments` so an explicit launch intent still wins.
`apps/desktop/src/window/hyprland.ts` reads each window's workspace over the compositor socket and moves the restored window back silently.
Neither decides where a window belongs; they only put back an arrangement the user already made, so `AGENTS.md`'s rule against encoding compositor policy holds.
Off Hyprland every operation is a no-op and the windows simply reopen.

Every provider subprocess receives `T3CODE_PROJECT_ID` and `T3CODE_THREAD_ID`.
A project window starts with its project id as the window title.
Hyprland keeps that value as `initialTitle`.

Tooling an agent runs from inside a project window can therefore find its own window without guessing from `cwd`.
`ProviderSessionStartInput.projectId` carries the id; the binding persists it so recovery after a restart keeps it.

Run `vp run fork:delta` for the commit list.

### Retirement condition

Delete this domain when either holds:

- The web client gains in-app browser preview, making a browser window or PWA shell per project acceptable.
- Upstream ships its own multi-window or project-scoped window support.

The first is the likely one.
`previewBridge.ts` returning something other than `null` on web is the signal to re-open this question.

Other desktop-only gaps may exist and are not yet enumerated.
Enumerate them before acting on a retirement, because preview parity alone may not be sufficient.

### Rebase scan

After every rebase onto upstream, check these before trusting a clean merge.

| Path                                                     | Why it matters                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/desktop/src/window/DesktopWindow.ts`               | The window service the fork makes plural. Upstream would land here. |
| `apps/desktop/src/window/WindowIdentity.ts`              | Fork-only. A conflict means upstream added its own identity model.  |
| `apps/desktop/src/window/DesktopWindowSession.ts`        | Fork-only. The manifest that carries windows across an update.      |
| `apps/desktop/src/window/hyprland.ts`                    | Fork-only. The only place that speaks to the compositor.            |
| `apps/desktop/src/updates/DesktopUpdates.ts`             | Captures the session before `destroyAll`. Upstream edits this file. |
| `apps/server/src/provider/providerSessionEnvironment.ts` | `T3CODE_PROJECT_ID` / `T3CODE_THREAD_ID`; every adapter calls it.   |
| `apps/desktop/src/app/DesktopClerk.ts`                   | Single-instance lock and deep-link forwarding.                      |
| `apps/desktop/src/preview/Manager.ts`                    | Preview namespacing by window.                                      |
| `apps/desktop/src/ipc/**`, `apps/desktop/src/preload.ts` | The bridge surface the web client gates on.                         |
| `packages/contracts/src/ipc.ts`                          | `openProjectWindow` lives here.                                     |
| `apps/web/src/routes/project.*`                          | Fork-only route subtree.                                            |
| `apps/web/src/routeTree.gen.ts`                          | Generated. Regenerate rather than resolving by hand.                |
| `apps/web/src/components/preview/previewBridge.ts`       | The retirement signal. Read it on every rebase.                     |
| `apps/web/src/components/CommandPalette.tsx`             | Entry point, and a busy upstream file.                              |

## custom-agents

### Need

Choose a provider-native custom agent as the main Claude or Codex thread.
Upstream T3 Code exposes model options but has no main-thread custom-agent control.

### Shape

Provider model capabilities carry an `agent` select descriptor.
The web composer renders that descriptor in its own picker beside the model and reasoning controls.
Compact web and mobile surfaces reuse the existing provider-options menus.

Claude agent inventory comes from the Agent SDK initialization result.
The selected name becomes the SDK's `--agent` launch argument.

Codex agent inventory comes from `<CODEX_HOME>/agents/*.toml`.

The selected definition becomes a `thread/start` or `thread/resume` config and instruction layer.
Project definitions can override personal Codex definitions with the same name at session start.

Selections persist in `modelSelection.options` and restore with the provider binding.
Changing the root agent restarts the provider session before the next turn.

### Retirement condition

Delete this domain when upstream can discover and select provider-native main-thread agents for Claude and Codex.
The upstream behavior must persist the selection and apply it on new and resumed sessions.

### Rebase scan

| Path                                                              | Why it matters                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/web/src/components/chat/ChatComposer.tsx`                   | Owns the composer control order.                          |
| `apps/web/src/components/chat/TraitsPicker.tsx`                   | Splits root agents from model traits.                     |
| `apps/web/src/components/chat/composerProviderState.tsx`          | Renders capability-driven composer controls.              |
| `apps/server/src/provider/Layers/ClaudeProvider.ts`               | Discovers Claude agents.                                  |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`                | Applies Claude's `--agent` launch argument.               |
| `apps/server/src/provider/Drivers/CodexAgents.ts`                 | Discovers and parses Codex agent definitions.             |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts`          | Layers Codex agent config and instructions onto a thread. |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`  | Restarts sessions when the root agent changes.            |
| `packages/contracts/src/model.ts`, `packages/shared/src/model.ts` | Own the generic provider-option contract.                 |

## markdown-editing

### Need

T3 Code renders Markdown previews and edits Markdown source, but it has no rich editing mode.
The fork needs one surface where a user can edit the rendered document and still save Markdown.

### Shape

The web file preview offers Rich and Source modes for `.md` files.
Rich mode uses a lazy-loaded Milkdown editor with CommonMark, GFM, YAML frontmatter, history, and clipboard support.

It reuses the existing optimistic file cache and save coordinator, so local and remote environments share one path.

MDX stays on the existing rendered preview because the Markdown pipeline cannot preserve JSX safely.
Truncated files remain read-only.

Run `vp run fork:delta` for the commit list.

### Retirement condition

Delete this domain when upstream ships a rich Markdown editor with safe frontmatter and MDX boundaries.
The replacement must use the existing file-save path and avoid loading its editor bundle during ordinary file browsing.

### Rebase scan

| Path                                                   | Why it matters                                           |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `apps/web/src/components/files/FilePreviewPanel.tsx`   | Owns the Rich/Source entry point and file-save boundary. |
| `apps/web/src/components/files/MarkdownRichEditor.tsx` | Fork-only Milkdown lifecycle and change publisher.       |
| `apps/web/src/components/files/markdownPipeline.ts`    | Fork-only syntax and serialization chain.                |
| `apps/web/src/components/files/filePreviewMode.ts`     | Keeps MDX outside the rich-editing boundary.             |
| `apps/web/package.json`, `pnpm-lock.yaml`              | Milkdown and round-trip-test dependencies.               |
| `apps/web/src/components/ChatMarkdown.tsx`             | Upstream preview changes may replace this domain.        |

## fork-meta

### Need

The fork's own documentation and conventions.
This domain exists so documentation and tooling commits are not mis-filed under a product domain.

### Shape

- The fork sections in `README.md`, `AGENTS.md`, and `docs/README.md`.
- This document, [Fork development](./fork-development.md), and the [Fork sync](../operations/fork-sync.md) runbook.
- `scripts/fork-delta.ts` with its `fork:delta` alias in the root `package.json`.
- The fork trailer section of `.github/pull_request_template.md`.

### Retirement condition

Retired with the fork.

### Rebase scan

| Path                                       | Why it matters                                                |
| ------------------------------------------ | ------------------------------------------------------------- |
| `README.md`, `AGENTS.md`, `docs/README.md` | Upstream edits these often and they carry fork-only sections. |
| `package.json` scripts block               | `fork:delta` sits between upstream aliases.                   |
| `docs/internals/scripts.md`                | Carries the `fork:delta` entry.                               |
| `scripts/*.ts` siblings                    | The ledger script copies their Effect CLI shape.              |
| `.github/pull_request_template.md`         | Carries the fork trailer block every squash body needs.       |

## distribution

### Need

Upstream releases ship upstream code, so a fork user needs a fork build and a fork update feed.
Upstream's workflows also target Blacksmith runners the fork does not have.

### Shape

- `.github/workflows/hyprws-ci.yml` runs checks, tests, the fork ledger, and the desktop build on `hyprws`.
- `.github/workflows/hyprws-release.yml` builds a Linux x64 AppImage from a `v*-hyprws.*` tag and publishes it.

Both run on GitHub-hosted runners, which are free for a public repository.

The updater needs no code.
`scripts/build-desktop-artifact.ts` derives the update feed from `GITHUB_REPOSITORY`.
Fork builds therefore update from fork releases.

Upstream workflows stay in the tree untouched and disabled.
Editing or deleting them is a standing rebase conflict.
[Fork sync](../operations/fork-sync.md) owns the disable step.

### Retirement condition

Retired with the fork, or when upstream publishes builds the fork can ship unchanged.

### Rebase scan

| Path                                          | Why it matters                                              |
| --------------------------------------------- | ----------------------------------------------------------- |
| `.github/workflows/ci.yml`                    | Copy new checks or setup steps into `hyprws-ci.yml`.        |
| `.github/workflows/release.yml`               | Copy Linux build-step changes into `hyprws-release.yml`.    |
| `scripts/build-desktop-artifact.ts`           | Build inputs, icon tooling, and the update feed resolution. |
| `scripts/update-release-package-versions.ts`  | Release version alignment the fork workflow calls.          |
| `package.json` `engines` and `packageManager` | Runner toolchain expectations.                              |

## upstream-fixes

### Need

Fixes the fork needs now that belong to no fork domain and would be correct in upstream T3 Code as they stand.
They sit at the bottom of the stack so each one can be offered upstream and dropped without touching a product domain.

### Shape

- One upstream-native commit per fix, `Fork-Tier: bugfix`, `Fork-Upstreamable: yes`.
- A lane created from `upstream/main`, so the fix carries no fork dependency.
- No shared helpers across fixes; each must drop alone.

### Retirement condition

Per commit: upstream ships the fix, and the next rebase drops the commit.
The domain retires when it is empty.

### Rebase scan

| Path                   | Why it matters                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| Each commit's own diff | A conflict usually means upstream fixed it differently; drop ours. |

## zmux-estate

### Need

A thread's terminal and worktree live in the same managed zmux estate the operator drives from the CLI.
Upstream spawns a plain shell per terminal and owns no session manager, so a thread's work is invisible outside the app.

### Shape

- `terminalSessionMode` chooses whether a new thread terminal opens a plain shell or attaches through `zmux open` to the session `zmux session resolve` names for the checkout.
- `zmuxSessions` binds a new thread worktree through `zmux wt --adopt` and kills that session when the worktree is removed.
- Every fallback to a plain shell prints its reason into the terminal buffer, and a missing `zmux` binary degrades silently to upstream behaviour.
- `apps/server/src/zmux/` holds the binder; the terminal manager and the worktree workflow call it through `ProcessRunner` with the inherited tmux variables stripped.

### Retirement condition

Upstream terminals can attach to an operator-chosen external session manager, and worktree lifecycle exposes hooks a session manager can bind to.

### Rebase scan

| Path                                                  | Why it matters                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/server/src/terminal/Manager.ts`                 | Shell candidate resolution and spawn env; the attach path hooks here. |
| `apps/server/src/git/GitWorkflowService.ts`           | Worktree create and remove; the bind and unbind calls hook here.      |
| `apps/server/src/zmux/**`                             | Fork-only. A conflict means upstream grew its own session model.      |
| `packages/contracts/src/settings.ts`                  | `terminalSessionMode` and `zmuxSessions` sit between upstream keys.   |
| `apps/web/src/components/settings/SettingsPanels.tsx` | Settings UI for both switches; a busy upstream file.                  |

## Adding a domain

A new domain needs its own section with the same four headings, and a row in the domain index.
Its name becomes the `Fork-Domain` trailer of its first commit.

Answer three questions before opening one:

1. What does upstream not do, stated as behavior rather than implementation?
2. What would upstream have to ship for this domain to be deleted?
3. Which upstream paths does it touch, so a rebase scan can find collisions?

If the third answer is "many files across unrelated systems", the change is probably not a domain.
It is probably a bugfix to send upstream, filed under `upstream-fixes`.

Keep the domain's new code in its own files so it replays cleanly onto upstream.
See [Extracting a domain](./fork-development.md#extracting-a-domain).
