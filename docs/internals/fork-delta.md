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

Each domain's **Rebase scan** table is checked the same way.

```bash
vp run fork:scan                    # every domain's scan against live upstream/main
vp run fork:scan --target vX.Y.Z    # the same walk pinned to a release tag
```

A file is shared when the fork changed it above its upstream base and upstream changed it too on the
way to the target, which is where a rebase merges two intents into one file. `fork:scan` fails when a
domain's own commits change a shared file its scan table does not list. Fork CI runs it on every push
against live `upstream/main` as an advisory step. The automated sync verifies the replay against its
selected clean tag; when a conflict needs a person, gates 3 and 4 of the
[`fork-sync`](../../.agents/skills/fork-sync/SKILL.md) unblock flow run the blocking scan against the
human-selected target. The [fork sync runbook](../operations/fork-sync.md) connects the feasibility
boundary, bot run summary, blocked issue, and human rehearsal. Every code span in a Path cell is one
pattern: `*` stays inside a path segment, `**` spans them.

## Why the fork exists

The fork carries a small set of independent domains that upstream T3 Code does not currently provide.
Each domain has its own need, patch boundary, and retirement condition.

Project-scoped windows were the first domain.
Upstream's desktop app is single-window by construction, with no window registry or per-window scope.
Electron also forwards a second launch to the first window instead of opening another.

For this domain, the premise is that a project window is the unit of desktop organization.
Each window can live on its own Hyprland workspace.

### The upstream-supported alternative

Point a browser at a self-hosted T3 backend and open one project per window.
Sessions, authentication, providers, and state are shared because it is the same server.

That alternative is real and needs no project-window fork machinery.
Browser mode still trails Electron for terminal workflows and nested in-app browser windows.
The in-app browser preview is desktop-only today.
`apps/web/src/components/preview/previewBridge.ts` resolves to `null` without an Electron host.

When browser mode reaches practical parity, normal browser windows become sufficient.
A small PWA-style Electron shell around the web client would also be enough.

That would retire the `project-windows` domain, not necessarily the fork.
The other domains in this ledger keep their own reasons to exist.

## Tiers

Every fork change carries one tier.

| Tier     | Meaning                                            | On retirement                        |
| -------- | -------------------------------------------------- | ------------------------------------ |
| `core`   | The domain does not work without it.               | Deleted with the domain.             |
| `qol`    | Polish. Drop it and the domain still works.        | Reassess individually.               |
| `bugfix` | A defect fix. Note whether upstream reproduces it. | Dropped once upstream supersedes it. |

A `bugfix` that upstream reproduces is a retire candidate, not fork delta we want to carry.
Wait for upstream to fix the defect on its own, then drop the commit at the next rebase.
The fork does not ask upstream to make that happen.

Every signalled commit gets one retirement outcome during the rebase. **Retire** records the dropped
subject under [Retired](#retired). **Keep** records the subject and reason under [Kept](#kept), so the
next report does not ask again. **Partial** records the same subject in both tables: the replacement
cell says what portion upstream supplied, while the keep reason says what fork behaviour remains.

## Trailers

Every fork commit carries `Fork-Domain` and `Fork-Tier`.
A `bugfix` also carries `Fork-Upstreamable`, so the ledger can tell a retire candidate from a fork-only fix.

**`Fork-Upstreamable: yes` is a tracking tag only.**
It marks a commit upstream is likely to supersede, so the rebase feasibility walk can flag it as a retire candidate.
It never means "send this upstream", and it never authorizes posting to `pingdotgg/t3code`.
The fork posts no pull request, issue, comment, review, or reaction upstream until at least 2026-11-27, possibly ever; only the human may lift that rule.

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

| Domain                                | Status | Tiers present     | Retires when                                                 |
| ------------------------------------- | ------ | ----------------- | ------------------------------------------------------------ |
| [project-windows](#project-windows)   | Active | core, qol, bugfix | Web preview parity, or upstream multi-window.                |
| [github-issues](#github-issues)       | Active | core, bugfix      | Upstream multi-environment Issues on web and desktop.        |
| [custom-agents](#custom-agents)       | Active | core              | Upstream main-thread custom-agent selection.                 |
| [markdown-editing](#markdown-editing) | Active | core              | Upstream ships safe rich Markdown editing.                   |
| [workspace-files](#workspace-files)   | Active | core              | Upstream supports ignored and trusted linked artifacts.      |
| [fork-meta](#fork-meta)               | Active | qol               | Never. It documents the fork itself.                         |
| [distribution](#distribution)         | Active | core              | Never, while the fork ships its own builds.                  |
| [upstream-fixes](#upstream-fixes)     | Active | bugfix            | Each commit, when upstream ships the fix.                    |
| [thread-ordering](#thread-ordering)   | Active | qol               | Upstream ships equivalent manual active-thread ordering.     |
| [zmux-estate](#zmux-estate)           | Active | core              | Upstream terminals attach to an external session manager.    |
| [worktrunk-hooks](#worktrunk-hooks)   | Active | core              | Upstream worktree lifecycle exposes create and remove hooks. |

Add a row per domain.
A domain is a reason the fork exists, not a feature area of the app.

## Retired

| Fork commit                                            | Domain          | Upstream replacement                                                                                                                                                                                                                         | Retired at |
| ------------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| fix(web): scope markdown actions to thread environment | project-windows | `pingdotgg/t3code#7140` (`082e6ea52`) inlines `threadRef?.environmentId ?? explicitEnvironmentId ?? null` at the same binding in `apps/web/src/components/ChatMarkdown.tsx`, leaving `resolveChatMarkdownEnvironmentId` a redundant wrapper. | v0.0.35    |

References in Upstream replacement are code-spanned records such as `pingdotgg/t3code#7140`, never
live links. A retired-only subject must no longer be present in the fork stack; `fork:delta --check`
reports it as `retired but present` until the rebase drops it.

## Kept

| Fork commit                                       | Domain          | Reason                                                                                                                                                                                                                                                                                                 | Reviewed at |
| ------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| refactor(web): add physical project sidebar scope | project-windows | `pingdotgg/t3code#8231` refactored the same `apps/web/src/components/Sidebar.logic.ts` comparator but still lists every project's threads; the fork's `isProjectInSidebarScope` is a separate export that survived the automerge intact and remains the only source of project-window sidebar scoping. | v0.0.35     |

A kept reason documents the fork behaviour that the overlap signal did not replace. A subject in
both Retired and Kept is a partial decision and remains in the active fork ledger.

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

QoL covers a retry when a scoped draft fails to start, `T3CODE_DESKTOP_DEVTOOLS=0`, route test naming, and project-window list scope. The shared resolver and toggle live in `apps/web/src/windowProjectScope.ts` and `apps/web/src/components/WindowProjectScopeToggle.tsx`; Pull Requests shares its search contract through `apps/web/src/components/pullRequest/pullRequestListRoute.ts`, adds `apps/web/src/routes/project.$environmentId.$projectId.pull-requests.tsx`, and resolves the project-window entry point in `apps/web/src/components/sidebar/SidebarChrome.tsx`.
Two bugfixes reproduce on an unmodified upstream build, so upstream is likely to fix them on its own and they are retire candidates; the rest are fork-only.

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

- Browser mode reaches practical Electron parity for this workflow, including terminals and nested browser windows.
- Upstream ships its own multi-window or project-scoped window support.

The first is the likely one.
`previewBridge.ts` returning something other than `null` on web is one signal to re-open this question.
Verify the complete browser/Electron gap before retiring the domain.

### Rebase scan

After every rebase onto upstream, check these before trusting a clean merge.

| Path                                                                      | Why it matters                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/desktop/src/window/DesktopWindow.ts`                                | The window service the fork makes plural. Upstream would land here. |
| `apps/desktop/src/window/WindowIdentity.ts`                               | Fork-only. A conflict means upstream added its own identity model.  |
| `apps/desktop/src/window/DesktopWindowSession.ts`                         | Fork-only. The manifest that carries windows across an update.      |
| `apps/desktop/src/window/hyprland.ts`                                     | Fork-only. The only place that speaks to the compositor.            |
| `apps/desktop/src/updates/DesktopUpdates.ts`                              | Captures the session before `destroyAll`. Upstream edits this file. |
| `apps/server/src/provider/providerSessionEnvironment.ts`                  | `T3CODE_PROJECT_ID` / `T3CODE_THREAD_ID`; every adapter calls it.   |
| `apps/server/src/provider/Layers/*Adapter.ts`                             | Every adapter passes that identity into its runtime.                |
| `apps/server/src/provider/Layers/CodexAdapter.test.ts`                    | Covers project identity propagation through Codex.                  |
| `apps/server/src/provider/Layers/ProviderService.ts`                      | Owns project-scoped provider session startup.                       |
| `apps/server/src/provider/Layers/ProviderService.test.ts`                 | Covers project-scoped provider session startup.                     |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`          | Carries `projectId` on the provider session start input.            |
| `apps/server/src/keybindings.test.ts`                                     | Covers project-window keybinding dispatch.                          |
| `apps/desktop/src/app/DesktopClerk.ts`                                    | Single-instance lock and deep-link forwarding.                      |
| `apps/desktop/src/preview/Manager.ts`                                     | Preview namespacing by window.                                      |
| `apps/desktop/src/ipc/**`, `apps/desktop/src/preload.ts`                  | The bridge surface the web client gates on.                         |
| `packages/contracts/src/ipc.ts`                                           | `openProjectWindow` lives here.                                     |
| `apps/web/src/routes/project.*`                                           | Fork-only route subtree.                                            |
| `apps/web/src/routes/project.$environmentId.$projectId.pull-requests.tsx` | Keeps Pull Requests inside the scoped project shell.                |
| `apps/web/src/windowProjectScope.ts`                                      | Shared project-window list-scope resolver and storage key.          |
| `apps/web/src/components/WindowProjectScopeToggle.tsx`                    | Shared project/all-project segmented control.                       |
| `apps/web/src/components/pullRequest/pullRequestListRoute.ts`             | Search contract shared by the hub and project routes.               |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                       | Resolves Pull Requests navigation within the active window scope.   |
| `apps/web/src/components/ChatView.tsx`                                    | Starts and navigates threads within project-window scope.           |
| `apps/web/src/components/Sidebar.logic.ts`                                | `isProjectInSidebarScope`; upstream reworks this comparator.        |
| `apps/web/src/components/Sidebar.logic.test.ts`                           | Fork scope cases sit beside upstream's ordering cases.              |
| `docs/user/thread-sidebar.md`                                             | Documents the scoped sidebar on a page upstream also edits.         |
| `docs/user/keybindings.md`                                                | Documents project-window keyboard entry points.                     |
| `apps/web/src/routeTree.gen.ts`                                           | Generated. Regenerate rather than resolving by hand.                |
| `apps/web/src/components/preview/previewBridge.ts`                        | The retirement signal. Read it on every rebase.                     |
| `apps/web/src/components/CommandPalette.tsx`                              | Entry point, and a busy upstream file.                              |
| `apps/web/src/components/ChatMarkdown.tsx`                                | Shared with `github-issues`; neither domain owns it alone.          |
| `packages/contracts/src/keybindings.ts`                                   | Defines the project-window keybinding action.                       |
| `packages/shared/src/keybindings.ts`                                      | Maps the project-window keybinding action across clients.           |

## github-issues

### Need

Browse GitHub issues and hand one to an agent on web and desktop, with project-window scope.

### Shape

The contracts and server expose read-only issue list and detail requests through the existing GitHub CLI integration. Lists degrade per project, merge capable environments, and keep environment identity on every client-side reference.

The web renderer provides hub and project-window routes with search, state and project filters, project/all-project scope, issue descriptions and comments, in-app link claiming, right-panel tabs, and an unsent "Work on this issue" hand-off to a fresh composer. The hand-off prompt is an environment-scoped template configured under Source Control settings. The palette intentionally has a “Go to Issues” command but no matching “Go to Pull Requests” command.

### Retirement condition

Delete the service and UI when upstream ships a stable GitHub Issues list, detail, and agent hand-off across web and desktop with multi-environment scoping. If upstream ships only the core service, retire this domain's service and UI while keeping the project-window scope adapter under `project-windows`.

### Rebase scan

| Path                                                                               | Why it matters                                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/contracts/src/githubIssue.ts`                                            | Wire issue shapes and tagged failures.                            |
| `packages/contracts/src/settings.ts`                                               | Environment-scoped issue hand-off prompt template.                |
| `packages/contracts/src/rpc.ts`, `packages/contracts/src/environment.ts`           | RPC registration and optional capability.                         |
| `apps/server/src/githubIssue/**`                                                   | GitHub CLI normalization, discovery, list, and detail service.    |
| `apps/server/src/sourceControl/GitHubCli.ts`                                       | Shared process boundary; excluded upstream CLI changes land here. |
| `apps/server/src/ws.ts`, `apps/server/src/server.ts`                               | Handler and server-lifetime service wiring.                       |
| `apps/server/src/auth/RpcAuthorization.ts`                                         | Read-only authorization scopes.                                   |
| `apps/server/src/environment/ServerEnvironment.ts`                                 | Static capability advertisement.                                  |
| `apps/server/src/environment/ServerEnvironment.test.ts`                            | Covers GitHub Issues capability advertisement.                    |
| `packages/contracts/src/environment.test.ts`                                       | Covers the optional GitHub Issues environment capability.         |
| `packages/client-runtime/src/state/githubIssues.ts`                                | Client-neutral atoms and multi-environment identity.              |
| `apps/web/src/routes/_chat.issues.tsx`                                             | Hub list and shared page implementation.                          |
| `apps/web/src/routes/project.$environmentId.$projectId.issues.tsx`                 | Project-scoped route wrapper.                                     |
| `apps/web/src/components/githubIssue/githubIssueRouteSearch.ts`                    | Shared route search contract.                                     |
| `apps/web/src/components/githubIssue/GitHubIssueDetailPanel.tsx`                   | Detail rendering and configurable composer hand-off.              |
| `apps/web/src/components/settings/GitHubIssueSettings.tsx`                         | Source Control setting for the hand-off prompt template.          |
| `apps/web/src/rightPanelStore.ts`, `apps/web/src/components/RightPanelTabs.tsx`    | Persisted issue surfaces and tabs.                                |
| `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/ChatMarkdown.tsx` | Detail rendering and link interception.                           |
| `apps/web/src/lib/openPullRequestLink.ts`                                          | Workspace issue URL claiming.                                     |
| `apps/web/src/lib/openPullRequestLink.test.ts`                                     | Covers issue URL claiming alongside pull requests.                |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                                | Scoped sidebar entry point.                                       |
| `apps/web/src/components/CommandPalette.tsx`                                       | Scoped command-palette entry point.                               |
| `docs/user/source-control.md`                                                      | Documents GitHub Issues browsing and hand-off.                    |

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

| Path                                                                                                                                    | Why it matters                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/web/src/components/chat/ChatComposer.tsx`                                                                                         | Owns the composer control order.                          |
| `apps/web/src/components/chat/TraitsPicker.tsx`                                                                                         | Splits root agents from model traits.                     |
| `apps/web/src/components/chat/composerProviderState.tsx`                                                                                | Renders capability-driven composer controls.              |
| `apps/server/src/provider/Layers/ClaudeProvider.ts`                                                                                     | Discovers Claude agents.                                  |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`                                                                                      | Applies Claude's `--agent` launch argument.               |
| `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`                                                                                 | Covers Claude agent discovery and launch behavior.        |
| `apps/server/src/provider/Drivers/CodexAgents.ts`                                                                                       | Discovers and parses Codex agent definitions.             |
| `apps/server/src/provider/Layers/CodexAdapter.ts`                                                                                       | Applies Codex agent selection at the adapter boundary.    |
| `apps/server/src/provider/Layers/CodexAdapter.test.ts`                                                                                  | Covers Codex agent selection and session behavior.        |
| `apps/server/src/provider/Layers/CodexCollabWire.test.ts`                                                                               | Covers Codex custom-agent collaboration wire behavior.    |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts`                                                                                | Layers Codex agent config and instructions onto a thread. |
| `apps/server/src/provider/Layers/CodexProvider.ts`                                                                                      | Builds the Codex agent select descriptor.                 |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` | Restarts sessions when the root agent changes.            |
| `apps/server/src/server.test.ts`                                                                                                        | Covers custom-agent behavior through server seams.        |
| `apps/server/package.json`, `pnpm-lock.yaml`                                                                                            | The `smol-toml` dependency the Codex parser needs.        |
| `packages/contracts/src/model.ts`, `packages/shared/src/model.ts`                                                                       | Own the generic provider-option contract.                 |
| `packages/contracts/src/orchestration.ts`                                                                                               | Carries selected agent options through orchestration.     |
| `docs/user/providers-codex.md`                                                                                                          | Documents Codex custom-agent selection.                   |

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
| `docs/README.md`                                       | Indexes the fork's Markdown editing documentation.       |

## fork-meta

### Need

The fork's own documentation and conventions.
This domain exists so documentation and tooling commits are not mis-filed under a product domain.

### Shape

- The fork sections in `README.md`, `AGENTS.md`, and `docs/README.md`.
- This document, [Fork development](./fork-development.md), and the [Fork sync](../operations/fork-sync.md) runbook.
- `scripts/fork-delta.ts` with its `fork:delta` alias in the root `package.json`.
- `scripts/fork-preflight.ts` with its `fork:preflight` alias, the precondition check every sync gate runs first.
- `scripts/fork-orient.ts` with its `fork:orient` alias, the single Gate 1 command that prints the orientation and its Stop block.
- `scripts/fork-scan.ts` with its `fork:scan` alias, the guard that keeps a domain's rebase scan honest.
- `scripts/fork-rebase-report.ts`, its artifact sibling, and `.github/workflows/hyprws-rebase-report.yml`.
- The bot-first sync model, bot-owned refs, human unblock, and stable-cut procedures in the
  [fork sync runbook](../operations/fork-sync.md) and repo-local
  [`fork-sync`](../../.agents/skills/fork-sync/SKILL.md) skill.
- `scripts/fork-upstream-watch.ts` with its `fork:upstream-watch` alias, and the `upstream-watch` label whose open issues it sweeps.
- `scripts/fork-upstream-refs.ts` with its `fork:upstream-refs` alias, the guard that keeps fork prose from posting backlinks upstream.
- The fork trailer section of `.github/pull_request_template.md`.

### Retirement condition

Retired with the fork.

### Rebase scan

| Path                                       | Why it matters                                                |
| ------------------------------------------ | ------------------------------------------------------------- |
| `README.md`, `AGENTS.md`, `docs/README.md` | Upstream edits these often and they carry fork-only sections. |
| `package.json` scripts block               | The `fork:*` aliases sit between upstream aliases.            |
| `docs/internals/scripts.md`                | Carries the `fork:*` script entries.                          |
| `docs/internals/ci.md`                     | Documents fork-specific CI and advisory scan behavior.        |
| `scripts/*.ts` siblings                    | The ledger script copies their Effect CLI shape.              |
| `.github/pull_request_template.md`         | Carries the fork trailer block every squash body needs.       |

## distribution

### Need

Upstream releases ship upstream code, so a fork user needs a fork build and a fork update feed.
Upstream's workflows also target Blacksmith runners the fork does not have.

### Shape

- `.github/workflows/hyprws-ci.yml` runs checks, tests, the fork ledger, the upstream-citation guard, and the desktop build on `hyprws`.
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

## workspace-files

### Need

Agent review artifacts often live in ignored scratch directories or in scratch shared across
worktrees. The workspace file surface must keep those paths hidden by default while letting the
operator reveal and read artifacts they deliberately created.

### Shape

- A client-local preference includes gitignored paths in workspace file listings on demand.
- The file-tree toolbar and General settings expose the same persisted preference.
- Listing ignored paths never changes repository ignore rules or weakens file-read containment.

### Retirement condition

Delete this domain when upstream can reveal ignored workspace paths on demand and safely read
explicitly trusted artifact links shared across worktrees.

### Rebase scan

| Path                                                  | Why it matters                                      |
| ----------------------------------------------------- | --------------------------------------------------- |
| `apps/server/src/workspace/WorkspaceEntries.ts`       | Combines the normal index with ignored VCS paths.   |
| `apps/server/src/vcs/GitVcsDriver.ts`                 | Lists ignored paths through Git's native rules.     |
| `packages/contracts/src/project.ts`                   | Carries the optional listing request.               |
| `packages/contracts/src/settings.ts`                  | Persists the client-local preference.               |
| `apps/web/src/components/files/FileBrowserPanel.tsx`  | Owns the file-tree toolbar toggle.                  |
| `apps/web/src/components/settings/SettingsPanels.tsx` | Owns the web/desktop settings entry point.          |
| `apps/mobile/src/features/files/**`                   | Applies the mobile device-local preference.         |
| `apps/server/src/workspace/WorkspaceFileSystem.ts`    | Retains containment and trusted-link read behavior. |

## thread-ordering

### Need

Operators need to keep active threads in their own priority order without pinning every thread or
letting new activity reshuffle the list.

### Shape

- Web and desktop expose an explicit Manual thread-order mode beside the project filter.
- Dragging is limited to active, unpinned threads in the same physical project.
- The preference is client-local and overlays the existing automatic order, so new threads append
  predictably and switching back to Automatic is lossless.
- Pinned, snoozed, and settled ordering remains unchanged.
- A center drop on another active thread creates or extends a visual group; an edge drop keeps the
  existing reorder behavior. Dragging outside a group removes the member, and one-member groups
  dissolve automatically.
- Group membership, names, and collapsed state persist beside the manual order. Automatic mode
  preserves but does not render those preferences.
- Initial and regenerated group names use the server's existing thread-title generation path;
  group headers also support inline manual renaming and dissolution.

### Retirement condition

Delete this domain when an upstream release provides equivalent manual ordering for active threads
without requiring the fork to migrate or discard saved order.

### Rebase scan

| Path                                                 | Why it matters                                      |
| ---------------------------------------------------- | --------------------------------------------------- |
| `packages/contracts/src/settings.ts`                 | Carries the Manual sort option.                     |
| `packages/client-runtime/src/state/threadSort.ts`    | Defines Manual as preserving supplied order.        |
| `apps/web/src/uiStateStore.ts`                       | Persists client-local per-project thread order.     |
| `apps/web/src/components/Sidebar.logic.ts`           | Overlays per-project order without crossing groups. |
| `apps/web/src/components/Sidebar.tsx`                | Owns the active-thread drag interaction.            |
| `apps/web/src/components/SidebarThreadGroup.tsx`     | Renders group headers and name controls.            |
| `packages/contracts/src/environmentHttp.ts`          | Types remote-safe group title generation.           |
| `apps/server/src/orchestration/ThreadGroupTitles.ts` | Reuses the thread-title generation service.         |
| `apps/web/src/components/LegacySidebar.tsx`          | Keeps the legacy sort control compatible.           |
| `docs/user/thread-sidebar.md`                        | Documents the user-visible behavior.                |

## upstream-fixes

### Need

Fixes the fork needs now that belong to no fork domain and would be correct in upstream T3 Code as they stand.
They sit at the bottom of the stack so each one drops without touching a product domain once upstream ships its own fix.
The fork does not offer them upstream; it waits for upstream to fix the defect and then retires the commit.

### Shape

- One upstream-native commit per fix, `Fork-Tier: bugfix`, `Fork-Upstreamable: yes` as a retire-candidate tag.
- A lane created from `upstream/main`, so the fix carries no fork dependency.
- No shared helpers across fixes; each must drop alone.

### Terminal focus contract

Three commits share one behavior contract while each still drops alone.
A rebase that drops one must re-check the other two against it.

- Thread jump keys, previous/next, and the command palette shortcut switch threads while the terminal has focus; every other key stays in the shell.
- Thread navigation always lands in the composer, even when that thread's terminal drawer is open.
- The terminal takes focus only on an explicit request: opening the drawer, creating or splitting a terminal, or `` ctrl+` `` from the composer.
  `` ctrl+` `` from the terminal returns to the composer with the drawer open; closing the drawer returns to the composer.
- The focused pane (composer, terminal drawer, right panel) shows a static ring in the focus-ring color; no animation.

Proof: `apps/web/src/components/ThreadTerminalDrawer.test.ts`, `ChatView.logic.test.ts`, and a Chrome pass on each landing.

### Retirement condition

Per commit: upstream ships the fix, and the next rebase drops the commit.
The domain retires when it is empty.

### Rebase scan

| Path                          | Why it matters                                                     |
| ----------------------------- | ------------------------------------------------------------------ |
| `**` (each commit's own diff) | A conflict usually means upstream fixed it differently; drop ours. |

## zmux-estate

### Need

A thread's terminal and worktree live in the same managed zmux estate the operator drives from the CLI.
Upstream spawns a plain shell per terminal and owns no session manager, so a thread's work is invisible outside the app.

### Shape

- `terminalSessionMode` is the single zmux switch: `"zmux"` attaches new thread terminals through `zmux open` to the session `zmux session resolve` names for the checkout, binds a new thread worktree through `zmux wt --adopt`, and kills that session when the worktree is removed.
- The retired `zmuxSessions` boolean folds into `terminalSessionMode` on load (`migrateLegacyZmuxSettings`); an old opt-in without an explicit mode becomes `"zmux"`.
- Every fallback to a plain shell prints its reason into the terminal buffer, and a missing `zmux` binary degrades silently to upstream behaviour.
- `apps/server/src/zmux/` holds the binder; the terminal manager and the worktree workflow call it through `ProcessRunner` with the inherited tmux variables stripped.

### Retirement condition

Upstream terminals can attach to an operator-chosen external session manager, and worktree lifecycle exposes hooks a session manager can bind to.

### Rebase scan

| Path                                                  | Why it matters                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/server/src/terminal/Manager.ts`                 | Shell candidate resolution and spawn env; the attach path hooks here.     |
| `apps/server/src/git/GitWorkflowService.ts`           | Worktree create and remove; the bind and unbind calls hook here.          |
| `apps/server/src/server.test.ts`                      | Covers zmux attachment and fallback through server seams.                 |
| `apps/server/src/zmux/**`                             | Fork-only. A conflict means upstream grew its own session model.          |
| `packages/contracts/src/settings.ts`                  | `terminalSessionMode` and its legacy migration sit between upstream keys. |
| `apps/web/src/components/settings/SettingsPanels.tsx` | Settings UI for the switch; a busy upstream file.                         |
| `apps/server/src/ws.ts`                               | Shares worktree lifecycle wiring with the zmux binder.                    |

## worktrunk-hooks

### Need

A thread worktree behaves like one the operator created with `wt switch --create` on the same project: the hooks in `.config/wt.toml` seed the checkout on create and clean up on remove.
Upstream runs `git worktree add` and `git worktree remove` directly, so a project that depends on those hooks gets a bare worktree and leaves per-branch state behind.

### Shape

- `ThreadEnvMode` gains `worktrunk` beside upstream's `local` and `worktree`: a fresh git worktree that also runs the project's Worktrunk hooks. It is a sibling option, labelled "New worktrunk", wherever upstream offers "New worktree": Settings → New threads, a project's Workspace default, `defaultThreadEnvMode` in `t3.json`, and the composer's Workspace picker. Upstream's `worktree` mode is untouched.
- A `worktrunk` thread sends `prepareWorktree.worktrunk: true` on its first turn. The server then drops a `t3-worktrunk` marker beside git's own `locked` file in the worktree's gitdir (`.git/worktrees/<name>/`) and runs `wt hook pre-start` and `wt hook post-start` in the new worktree, ahead of the `t3.json` setup script. Removing a marked worktree runs `wt hook pre-remove` in it first and `wt hook post-remove` in the primary checkout after; `git worktree remove` deletes the marker with the gitdir, so no thread or project state records the mode. Local VCS status reports `worktrunk: true` while the marker exists, which is how a started thread's composer reads "Worktrunk" instead of "Worktree".
- Every hook runs headless through `wt hook <type> --yes`: `pre-*` hooks block, `post-start` returns once `wt` has detached its hooks, and a failed create hook lands as an error activity on the thread.
- `.config/wt.toml` in the project and `wt` on the server's PATH gate every hook; a mode without either degrades silently to upstream `worktree` behaviour. There is no separate on/off switch.
- Not supported: pull-request threads (two-valued `local`/`worktree`, no hooks) and mobile, which maps a `worktrunk` default to a plain worktree.
- Worktree paths stay T3 Code's; the fork never delegates to `wt switch` or `wt remove`.
- `apps/server/src/worktrunk/` holds the hook runner; it calls `wt` through `ProcessRunner` with the inherited tmux variables stripped.
- The domain carries no persistence column. An earlier shape added one through an idempotent pass in `ForkSchema.ts`, because upstream's numbered migration list collides on rebase; a future fork column needs that pattern again, never a numbered upstream migration.

### Retirement condition

Upstream worktree lifecycle exposes create and remove hooks a project can bind shell commands to.

### Rebase scan

| Path                                                          | Why it matters                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/server/src/worktrunk/**`                                | Fork-only. A conflict means upstream grew its own worktree hook model.                |
| `packages/contracts/src/environment.ts`                       | `ThreadEnvMode` carries the third literal; a new upstream mode lands beside it.       |
| `packages/contracts/src/orchestration.ts`                     | `prepareWorktree.worktrunk` on the bootstrap payload.                                 |
| `packages/shared/src/threadEnvMode.ts`                        | `isWorktreeEnvMode`; upstream code comparing `=== "worktree"` must route through it.  |
| `apps/server/src/ws.ts`                                       | Thread bootstrap worktree create; the create hooks run before the setup script.       |
| `apps/server/src/server.test.ts`                              | Covers worktrunk lifecycle behavior through server seams.                             |
| `packages/contracts/src/git.ts`                               | `worktrunk` on the local status result.                                               |
| `apps/server/src/git/GitWorkflowService.ts`                   | Status carries the marker; on remove it decides the pre-remove and post-remove calls. |
| `apps/web/src/components/BranchToolbar.logic.ts`              | `EnvMode`, its labels, and every worktree-shaped resolver.                            |
| `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`    | Composer Workspace picker; the third item, its icon, and the locked label.            |
| `apps/web/src/components/BranchToolbar.tsx`                   | Mobile-width Workspace menu; the same third item.                                     |
| `apps/web/src/components/ChatView.tsx`                        | Sends `worktrunk: true` on the first turn; feeds the status flag to the toolbar.      |
| `apps/web/src/components/ChatView.logic.ts`                   | Shares worktree-shaped thread-start logic with the worktrunk mode.                    |
| `apps/web/src/components/settings/SettingsPanels.tsx`         | New threads select; a busy upstream file.                                             |
| `apps/web/src/components/settings/ProjectSettingsPanel.tsx`   | Project Workspace select.                                                             |
| `apps/mobile/src/features/threads/new-task-flow-provider.tsx` | Maps a `worktrunk` default to `worktree`.                                             |

## Adding a domain

A new domain needs its own section with the same four headings, and a row in the domain index.
Its name becomes the `Fork-Domain` trailer of its first commit.

Answer three questions before opening one:

1. What does upstream not do, stated as behavior rather than implementation?
2. What would upstream have to ship for this domain to be deleted?
3. Which upstream paths does it touch, so a rebase scan can find collisions?

If the third answer is "many files across unrelated systems", the change is probably not a domain.
It is probably a bugfix rather than a domain, and it belongs to `upstream-fixes`.

Keep the domain's new code in its own files so it replays cleanly onto upstream.
See [Extracting a domain](./fork-development.md#extracting-a-domain).
