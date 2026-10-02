# Fork delta

> Fork-only inventory for `RSI-Software/t3code-hyprws`.

[Fork development](./fork-development.md) owns discipline; this document owns the inventory.
Read it before deciding whether a change belongs in the fork.

```bash
vp run fork:delta           # ledger grouped by domain and tier
vp run fork:delta --check   # exit 1 on a missing or invalid trailer
vp run fork:delta --json    # the same ledger for tooling
vp run fork:delta --inventory --upstream vX.Y.Z # overlap stats per domain
```

Commit lists are generated, because hashes rot on every rebase.
The default range is `upstream/main..HEAD`; `--base` and `--head` override it.

## Rebase scans

Each domain's **Rebase scan** table lists the upstream paths its commits touch.

```bash
vp run fork:scan                    # every domain against live upstream/main
vp run fork:scan --target vX.Y.Z    # the same walk pinned to a tag
```

`fork:scan` fails when a domain's own commits change a file its table omits and upstream also changed.
Every code span in a Path cell is one pattern: `*` stays inside a segment, `**` spans them.

| Where                                                     | Mode                 | Against                 |
| --------------------------------------------------------- | -------------------- | ----------------------- |
| Fork CI                                                   | Blocking, every push | its upstream merge base |
| The sync driver's check step (`hyprws-upstream-sync.yml`) | Blocking             | the target tag          |

## Why the fork exists

The fork carries independent domains upstream does not provide, each with its own need, patch boundary, and retirement condition.
Multiple desktop windows were the first: upstream's desktop app is single-window by construction, and a second launch forwards to the first window.

### The upstream-supported alternative

Point a browser at a self-hosted backend and open one tab per window, sharing sessions, auth, providers, and state.
Browser mode still trails Electron for terminals and nested in-app browser windows: `apps/web/src/components/preview/previewBridge.ts` resolves to `null` without an Electron host.
At parity, plain browser windows or a small Electron shell suffice, which retires `multi-window`, not the fork.

## Tiers

| Tier     | Meaning                                  | On retirement                       |
| -------- | ---------------------------------------- | ----------------------------------- |
| `core`   | The domain does not work without it      | Deleted with the domain             |
| `qol`    | Polish; the domain works without it      | Reassess individually               |
| `bugfix` | A defect fix; note upstream reproduction | Dropped once upstream supersedes it |

A `bugfix` upstream reproduces is a retire candidate: wait for upstream's fix, then drop the commit at the next rebase.
Every signalled commit gets one retirement outcome during the rebase.
A retirement is recorded by the retire commit itself, not a ledger.

## Trailers

| Trailer             | Values                        | Required on            |
| ------------------- | ----------------------------- | ---------------------- |
| `Fork-Domain`       | A domain from the index below | Every fork commit      |
| `Fork-Tier`         | `core`, `qol`, `bugfix`       | Every fork commit      |
| `Fork-Upstreamable` | `yes`, `no`                   | Every `bugfix`         |
| `Fork-Repair`       | The upstream tag of the walk  | Every sync walk repair |

`Fork-Upstreamable: yes` is a tracking tag, never authorization to post upstream; `AGENTS.md` owns that rule.
`Fork-Repair` marks a repair the next fold absorbs.
`vp run fork:delta --check` enforces the table on every push, and a rebase preserves trailers.

**Squash-body mode.** The advisory `hyprws Body` workflow runs `--check --squash-body <file>`; it is not a required check.
It validates the body's final trailer paragraph, which becomes the squash trailers.
A trailer carried only by a branch commit cannot satisfy it.

## Carry cost

Decided per commit by the levers retire, reshape, automate, or accept; no gate carries a numeric cap.
**Accept is never "as-is".** A kept commit needs a mechanical seam: fork code in fork-only files, and upstream files carrying only marked hook lines the walk re-applies.

### Marking a hook

| Case           | Marker                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| Statement      | trailing `// fork-hook: <domain>/<name>` or `/* fork-hook: … */`          |
| Multi-line JSX | the pair `{/* fork-hook: <domain>/<name> */}` and `{/* fork-hook-end */}` |

**A hook is exactly one construct:** one import, one call, one `const` from a single fork call, one JSX element, one fork-named property or spread, or one re-export.
**A hook never removes or modifies an upstream line**, except that a marked JSX region may re-indent what it wraps, and an in-place substitution removes the line its marked replacement supplies.

**A trailing marker covers the whole statement it closes.** `statementStartLine` in `scripts/lib/fork-hooks.ts` walks back from the marker line.

| Line above, at the statement's own depth | Walk      |
| ---------------------------------------- | --------- |
| Inside an open bracket or literal        | continues |
| Ends in `;`, `{`, `,`, or a closing `}`  | stops     |
| Blank or comment-only                    | stops     |

The hook guard, `scripts/lib/fork-hook-guard.ts`, refuses every added line outside the span, so comment placement decides the outcome.

| Comment                   | Span                      | Guard   |
| ------------------------- | ------------------------- | ------- |
| Above the hook            | starts below the comment  | refuses |
| Between `=>` and the body | starts at the body        | refuses |
| Inside the call arguments | open bracket: walk passes | accepts |

Refused: the comment stops the walk, leaving the `const` line and the comment unmarked.

```ts
const trackInstaller = (install: (session: Session) => void) =>
  // Each window installs its download handler on every browser session.
  Effect.acquireRelease(
    Effect.sync(() => installers.add(install)),
    () => Effect.sync(() => installers.delete(install)),
  ); // fork-hook: multi-window/download-track
```

Accepted: the comment sits inside the open call.

```ts
const trackInstaller = (install: (session: Session) => void) =>
  Effect.acquireRelease(
    // Each window installs its download handler on every browser session.
    Effect.sync(() => installers.add(install)),
    () => Effect.sync(() => installers.delete(install)),
  ); // fork-hook: multi-window/download-track
```

## Domain index

| Domain                                  | Status | Tiers present     | Retires when                              |
| --------------------------------------- | ------ | ----------------- | ----------------------------------------- |
| [multi-window](#multi-window)           | Active | core, qol, bugfix | Upstream ships multi-window support       |
| [workspaces](#workspaces)               | Active | core, qol         | Upstream ships per-window project filters |
| [browser-bookmarks](#browser-bookmarks) | Active | core              | Upstream ships durable bookmarks          |
| [backend-attach](#backend-attach)       | Active | core              | Upstream ships desktop attach             |
| [github-issues](#github-issues)         | Active | core, bugfix      | Upstream ships multi-environment Issues   |
| [custom-agents](#custom-agents)         | Active | core              | Upstream main-thread agent selection      |
| [device-auth](#device-auth)             | Active | core              | Upstream ships native client approval     |
| [markdown-editing](#markdown-editing)   | Active | core              | Upstream ships rich Markdown editing      |
| [workspace-files](#workspace-files)     | Active | core              | Upstream supports linked artifacts        |
| [fork-meta](#fork-meta)                 | Active | core, qol, bugfix | Never; it documents the fork              |
| [distribution](#distribution)           | Active | core              | Never, while the fork ships builds        |
| [upstream-fixes](#upstream-fixes)       | Active | bugfix            | Per commit, on the upstream fix           |
| [thread-ordering](#thread-ordering)     | Active | qol               | Upstream ships named groups               |
| [thread-fork](#thread-fork)             | Active | core              | Upstream ships same-provider thread fork  |
| [zmux-estate](#zmux-estate)             | Active | core              | Upstream terminals attach externally      |
| [worktrunk-hooks](#worktrunk-hooks)     | Active | core, bugfix      | Upstream exposes worktree lifecycle hooks |

A domain is a reason the fork exists, not a feature area.

## multi-window

### Need

- **Windows:** many windows, one shared backend
- **Identity:** an opaque id, stable across restore

### Shape

A window registry keyed by an opaque `WindowId`, sender-owned dispatch, and a manifest restore with one entry per window.

| Seam     | Fork boundary                                                                             |
| -------- | ----------------------------------------------------------------------------------------- |
| Identity | `WindowId` minted in main at create, carried as a preload argument                        |
| Dispatch | `main`-window consumers resolve to the sender or most recent window                       |
| Requests | One table in `WindowDispatch.fork.ts` maps each window request to create, reuse, or focus |
| Startup  | A bounded intent queue drained once the renderer can load                                 |
| Restore  | Manifest v2, one entry per window: `windowId`, route, bounds, workspace                   |
| Scope    | Sidebar project scope per `WindowId`; a preload argument seeds it                         |
| Legacy   | Old `#/project/…` links and routes decode to ordinary ones (`legacyProjectLink.fork.ts`)  |
| Drafts   | Project-route drafts fold into route-free buckets once (`projectDraftMigration.fork.ts`)  |
| Provider | `T3CODE_PROJECT_ID` and `T3CODE_THREAD_ID` name the work, never a window                  |

Hyprland places windows; update restore only puts each back on its recorded workspace, and is a no-op off Hyprland.

### Retirement condition

Upstream ships its own multi-window support.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Why it matters                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `apps/desktop/src/window/DesktopWindow.ts`, `apps/desktop/src/app/DesktopApp.ts`, `apps/desktop/src/ipc/methods/window.ts`, `apps/desktop/src/window/hyprland.ts`                                                                                                                                                                                                                                                                                                                                                                       | Registry, dispatch, startup, restore      |
| `apps/desktop/src/window/WindowIdentity.ts`, `apps/desktop/src/window/DesktopWindowSession.ts`, `apps/desktop/src/preview/WindowPolicy*.ts`, `apps/desktop/src/ipc/**`, `packages/contracts/src/ipc.ts`                                                                                                                                                                                                                                                                                                                                 | Identity, session manifest, previews, IPC |
| `apps/web/src/uiStateStore.ts`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/windowSidebarScope.fork.ts`, `apps/desktop/src/window/WindowScopeSeed.fork.ts`                                                                                                                                                                                                                                                                                                                                                                     | Per-window sidebar scope                  |
| `apps/desktop/src/electron/ElectronWindow.ts`, `apps/desktop/src/app/DesktopAppActivation.ts`, `apps/desktop/src/snapShot/DesktopSnapShot.ts`                                                                                                                                                                                                                                                                                                                                                                                           | Sender and most-recent window targets     |
| `apps/desktop/src/app/DesktopClerk*.ts`, `apps/desktop/src/app/DesktopConfig.ts`, `apps/desktop/src/app/DesktopEnvironment*.ts`, `apps/desktop/src/app/DesktopLifecycle.test.ts`, `apps/desktop/src/backend/DesktopBackendPool.test.ts`, `apps/desktop/src/electron/ElectronWindow.test.ts`, `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/preview/Manager*.ts`, `apps/desktop/src/updates/**`, `apps/desktop/src/ssh/DesktopSshPasswordPrompts.test.ts`, `apps/desktop/src/window/*.ts`, `.env.example` | Desktop app, preview, and update restore  |
| `apps/server/src/provider/providerSessionEnvironment.ts`, `packages/contracts/src/provider.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                          | Provider project and thread ids           |
| `apps/web/src/routes/__root.tsx`, `apps/web/src/routes/_chat*.tsx`, `apps/web/src/routes/settings.tsx`, `apps/web/src/routeTree.gen.ts`, `apps/web/src/threadRoutes*.ts`, `apps/web/src/components/ThreadRouteView.tsx`, `apps/web/src/hooks/useHandleNewThread.ts`, `apps/web/src/hooks/useThreadActions.ts`, `apps/web/src/state/shell.ts`, `apps/web/src/lib/t3ProjectFileDefaults.ts`, `apps/web/src/composerDraftStore*.ts`                                                                                                        | Routes, navigation, drafts                |
| `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/components/LegacySidebar.tsx`, `apps/web/src/components/Sidebar.logic*.ts`, `apps/web/src/components/sidebar/SidebarChrome.tsx`, `apps/web/src/components/pullRequest/PullRequestListFilters.tsx`, `apps/web/src/components/settings/KeybindingsSettings.tsx`                                                                                                                       | Window actions in shared web surfaces     |
| `packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`, `package.json`, `t3.json`, `scripts/dev-desktop-agent.ts`, `scripts/lib/dev-desktop-agent.ts`, `docs/user/keybindings.md`, `docs/user/thread-sidebar.md`                                                                                                                                                                                                                                                                                                 | Keybindings, desktop agent tooling, docs  |

## workspaces

### Need

- **Filter:** each window shows its own project set
- **Chooser:** picks the window's projects
- **Scope:** narrows lists, never hides work

### Shape

A fork-owned per-window project filter projecting selected refs into upstream's `scopedProjectKeys`.

| Seam    | Fork boundary                                                              |
| ------- | -------------------------------------------------------------------------- |
| Filter  | `useWindowProjectFilter()`, client-local; no wire change                   |
| Storage | Desktop per `WindowId`, web tab `sessionStorage`, mobile device preference |
| Adapter | A small fork-owned adapter around the single-select scope combobox         |
| Chooser | Sidebar header Projects chooser, project rows, palette, scope labels       |
| Scope   | Palette search, new-thread target, outside-thread add, window title        |

### Retirement condition

Upstream ships per-window project filters with equivalent chooser controls.

### Rebase scan

| Path                                                                                                                                                                                                             | Why it matters                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `apps/web/src/windowProjectFilter.fork.ts`, `apps/web/src/components/Sidebar*.tsx`, `apps/web/src/components/Sidebar.tsx`                                                                                        | Scope seams and chooser          |
| `apps/web/src/state/pullRequests.ts`, `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/composerDraftStore.ts`                                                                                         | Scoped lists, palette, drafts    |
| `apps/web/src/routes/_chat.tsx`, `apps/web/src/routes/_chat.issues.tsx`, `apps/web/src/routes/_chat.pull-requests.tsx`, `packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`            | Chooser keybinding, scope labels |
| `apps/mobile/src/features/home/HomeRouteScreen.tsx`, `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx`, `apps/mobile/src/persistence/mobile-preferences.ts`, `packages/client-runtime/package.json` | Mobile filter, shared model      |
| `apps/web/src/components/chat/ChatHeader.tsx`, `apps/web/src/routes/__root.tsx`, `packages/shared/package.json`                                                                                                  | Outside-thread add, window title |
| `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/components/Sidebar*.ts`, `apps/web/src/components/pullRequest/pullRequestProjectFilter.logic*.ts`, `apps/web/src/index.css`                        | Pull-request project scope       |

## browser-bookmarks

### Need

- **Need:** durable browser shortcuts
- **Scope:** per project, per profile

### Shape

- **Storage:** one global, per-project collections
- **Star:** saves, moves, or removes a page
- **New tab:** Project and Global before recents
- **Store:** normalizes, dedupes, caps, watches
- **Wire:** no server contract, no IPC

### Retirement condition

Upstream ships durable bookmarks in both scopes, with equivalent address-field controls and cross-window consistency.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                         | Why it matters                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/web/src/browserBookmarkStore.ts`, `apps/web/src/components/preview/PreviewBookmarkCard.tsx`, `apps/web/src/components/preview/PreviewBookmarkMenu.tsx`, `docs/fork/user/browser.md`                                                                                                                                                                                                                                                    | Fork-only; a conflict means upstream took the path |
| `apps/web/src/browserBookmarkStore.test.ts`, `apps/web/src/browserHistoryStore.ts`, `apps/web/src/components/preview/PreviewBookmarkMenu.test.tsx`, `apps/web/src/components/preview/PreviewChromeRow.tsx`, `apps/web/src/components/preview/PreviewEmptyState.tsx`, `apps/web/src/components/preview/PreviewEmptyState.test.tsx`, `apps/web/src/components/preview/PreviewView.tsx`, `apps/web/src/components/preview/PreviewView.test.tsx` | Shared web surfaces                                |
| `README.md`, `docs/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                | Shared tooling, workflows, and docs                |

## github-issues

### Need

- **Browse:** issues on web and desktop
- **Hand off:** one issue, window-scoped

### Shape

- **Server:** list, detail, close, and reopen
- **Lists:** degrade per project, keep identity
- **Web:** routes, filters, comments, tabs
- **Hand-off:** unsent draft from a template
- **Palette:** Issues only, no PR twin
- **Search:** `githubIssueSettingsSearch.ts`

The `github-issue-settings-search` guard rejects adding that item back into the upstream registry.

### Thread links

- **Links:** threads persist linked issues
- **MCP:** agents link, unlink, and list issues
- **Table:** `ForkSchema.ts` pass, never a migration
- **Live:** shell refetch carries the links
- **Detail:** no issue events, old-client safe
- **Sync:** an older snapshot never wins
- **Downgrade:** older servers reject link events

### Retirement condition

| Upstream ships                           | Action                                    |
| ---------------------------------------- | ----------------------------------------- |
| Issues list, detail, close, and hand-off | Delete the service and UI                 |
| The core service only                    | Keep the scope adapter under `workspaces` |

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why it matters                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `packages/client-runtime/src/state/sharedSettings.ts`, `packages/contracts/src/githubIssue.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/orchestration.ts`, `packages/contracts/src/environment.ts`, `packages/contracts/src/environment.test.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/settings.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Shared contracts and wire schemas     |
| `apps/server/src/githubIssue/**`, `apps/server/src/sourceControl/GitHubCli.ts`, `apps/server/src/ws.ts`, `apps/server/src/server.ts`, `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts`, `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts`, `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/environment/ServerEnvironment.ts`, `apps/server/src/environment/ServerEnvironment.test.ts`, `apps/server/src/pullRequest/PullRequestService.ts`, `apps/server/src/pullRequest/PullRequestService.test.ts`, `apps/server/src/mcp/McpHttpServer.ts`, `apps/server/src/provider/RuntimeInstructions.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Shared server and orchestration seams |
| `apps/web/src/routes/_chat.issues.tsx`, `apps/web/src/routes/project.$environmentId.$projectId.issues.tsx`, `apps/web/src/components/githubIssue/githubIssueRouteSearch.ts`, `apps/web/src/components/githubIssue/GitHubIssueDetailPanel.tsx`, `apps/web/src/components/settings/GitHubIssueSettings.tsx`, `apps/web/src/components/settings/githubIssueSettingsSearch.ts`, `apps/web/src/components/settings/githubIssueSettingsSearch.fork.test.ts`, `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts`, `apps/web/src/rightPanelStore.ts`, `apps/web/src/components/RightPanelTabs.tsx`, `apps/web/src/rightPanelStore.test.ts`, `apps/web/src/components/RightPanelTabs.test.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/lib/openPullRequestLink.ts`, `apps/web/src/lib/openPullRequestLink.test.ts`, `apps/web/src/components/sidebar/SidebarChrome.tsx`, `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/components/ChatMarkdown.test.tsx`, `apps/web/src/components/CommandPalette.logic.ts`, `apps/web/src/components/CommandPalette.logic.test.ts`, `apps/web/src/components/settings/SourceControlSettings.tsx`, `apps/web/src/components/settings/settingsSearch.ts`, `apps/web/src/routes/_chat.pull-requests.tsx`, `apps/web/src/state/pullRequests.ts`, `apps/web/src/routeTree.gen.ts` | Shared web surfaces                   |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Shared desktop and Electron seams     |
| `packages/client-runtime/src/state/githubIssues.ts`, `packages/client-runtime/package.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Shared packages                       |
| `docs/user/source-control.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Shared tooling, workflows, and docs   |

## custom-agents

### Need

- **Need:** a custom agent as main thread
- **Gap:** upstream exposes models only

### Shape

Provider model capabilities carry an `agent` select descriptor, rendered in the web composer picker and in the compact provider-options menus.

| Provider | Inventory                       | Applied as                                     |
| -------- | ------------------------------- | ---------------------------------------------- |
| Claude   | Agent SDK initialization result | the `--agent` launch argument                  |
| Codex    | `<CODEX_HOME>/agents/*.toml`    | `thread/start` or `thread/resume` config layer |

- **Override:** project beats personal by name
- **Persist:** in `modelSelection.options`
- **Change:** restarts the provider session
- **Descriptors:** the two `*AgentOptions.fork.ts`
- **Panel:** one roster of child work
- **Selection:** `AgentSpawnNavigation.ts`

The `provider-agent-boundary` and `agent-spawn-navigation` guards keep those declarations out of the upstream provider and timeline files.
An unsupported provider reports child detail as unavailable instead of presenting an inert row.

### Retirement condition

Upstream discovers and selects provider-native main-thread agents for Claude and Codex, persisting the selection across new and resumed sessions.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why it matters                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `packages/contracts/src/model.ts`, `packages/shared/src/model.ts`, `packages/contracts/src/orchestration.ts`, `packages/contracts/src/environmentHttp.ts`, `packages/contracts/src/providerRuntime.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Shared contracts and wire schemas     |
| `apps/server/src/provider/Layers/ClaudeProvider.ts`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `apps/server/src/provider/Drivers/CodexAgents.ts`, `apps/server/src/provider/Layers/CodexProvider.ts`, `apps/server/package.json`, `pnpm-lock.yaml`, `apps/server/src/checkpointing/CheckpointDiffQuery.test.ts`, `apps/server/src/project/ProjectSetupScriptRunner.test.ts`, `apps/server/src/provider/Drivers/CodexDriver.ts`, `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts`, `apps/web/src/keybindings.fork.test.ts`, `apps/web/src/uiStateStore.fork.test.ts`, `apps/server/src/serverRuntimeStartup.test.ts`, `apps/server/src/project/AgentSessionScanner.test.ts` | Shared server and orchestration seams |
| `apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/chat/TraitsPicker.tsx`, `apps/web/src/components/chat/composerProviderState.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/AgentsPanel.tsx`, `apps/web/src/components/AgentDetailPanel.tsx`, `apps/web/src/rightPanelStore.ts`, `apps/web/src/components/chat/MessagesTimeline.tsx`, `apps/web/src/components/chat/AgentSpawnNavigation*`, `apps/web/src/rightPanelStore.test.ts`, `apps/web/src/components/chat/composerProviderState.test.tsx`, `apps/web/src/connection/runtime.ts`, `apps/web/src/providerModels.ts`                                                                                                                                                       | Shared web surfaces                   |
| `apps/mobile/src/lib/threadActivity.ts`, `apps/mobile/src/lib/threadActivity.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Shared mobile surfaces                |
| `packages/client-runtime/package.json`, `packages/client-runtime/src/state/orchestration.ts`, `packages/client-runtime/src/state/threadReducer.ts`, `packages/client-runtime/src/state/subagentRuntime.ts`, `packages/client-runtime/src/state/subagentRuntime.test.ts`, `packages/client-runtime/src/state/subagentDetail.ts`, `packages/client-runtime/src/state/agentActivityHttp.ts`, `packages/client-runtime/src/state/threadReducer.test.ts`                                                                                                                                                                                                                                                                                                                              | Shared packages                       |
| `docs/user/providers-codex.md`, `docs/user/providers-claude.md`, `README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Shared tooling, workflows, and docs   |

## markdown-editing

### Need

- **Gap:** preview and source, never rich
- **Need:** edit rendered, save Markdown

### Shape

- **Modes:** Rich and Source for `.md`
- **Rich:** lazy Milkdown, GFM, frontmatter
- **Save:** the existing cache and coordinator
- **Excluded:** MDX and truncated files
- **Manifest:** granular `@milkdown/*` only
- **Pin:** `richMarkdownDependencies.fork.test.ts`

The `rich-markdown-boundary` guard rejects editor imports and inline rich surfaces in `FilePreviewPanel`.
`@milkdown/react` depends on `@milkdown/crepe`, which drags a Vue runtime and CodeMirror into a React-only app.
During historical repair, derive the lockfile from the accepted manifests with `vp i`.

### Retirement condition

Upstream ships rich Markdown editing with safe frontmatter and MDX boundaries, on the existing save path, loading no editor bundle during ordinary browsing.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Why it matters                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/web/src/components/files/MarkdownRichEditor.tsx`, `apps/web/src/components/files/markdown-rich-editor.css`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Fork-only; a conflict means upstream took the path |
| `apps/web/src/components/files/FilePreviewPanel.tsx`, `apps/web/src/components/files/RichMarkdownPreviewBoundary.tsx`, `apps/web/src/components/files/RichMarkdownPreviewBoundary.fork.test.ts`, `apps/web/src/components/files/markdownPipeline.ts`, `markdownPipeline.test.ts`, `apps/web/src/components/files/markdownEditorPresentation.ts`, `apps/web/src/components/files/richMarkdownEditorLinks.ts`, `apps/web/src/components/files/richMarkdownEditorLinks.fork.test.ts`, `apps/web/src/components/files/markdownFrontmatter.ts`, `markdownSerializerFixes.ts`, `apps/web/src/components/files/richMarkdownDependencies.fork.test.ts`, `apps/web/package.json`, `apps/web/src/components/ChatMarkdown.tsx` | Shared web surfaces                                |
| `docs/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Shared tooling, workflows, and docs                |
| `pnpm-lock.yaml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Other shared paths                                 |

## fork-meta

### Need

- **Holds:** fork docs, conventions, tooling
- **Why:** keeps meta out of a domain

### Shape

| Item                                                                                              | Role                                               |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `README.md`, `AGENTS.md`, `docs/README.md`                                                        | The fork sections                                  |
| This document, [Fork development](./fork-development.md), [Fork sync](../operations/fork-sync.md) | Fork documentation                                 |
| `scripts/fork-*.ts` and their `fork:*` aliases                                                    | The fork tooling; hand-run ones get an alias       |
| [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill                                   | The sync driver's run and unblock procedure        |
| `.github/workflows/hyprws-upstream-sync.yml`                                                      | The sync workflow and its fork-local issue upserts |
| `.github/pull_request_template.md` trailer block                                                  | Points to `FORK_DOMAINS` for the domain list       |

Every fork workflow checkout that runs rebased code scrubs its persisted credential first; `hyprws-upstream-sync.yml`'s scrub step is the pattern.

### Retirement condition

Retired with the fork.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Why it matters                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `packages/contracts/src/settings.test.ts`, `apps/web/src/components/ChatView.logic.test.ts`, `apps/web/src/components/Sidebar.logic.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Shared contracts and wire schemas     |
| `apps/server/src/pullRequest/PullRequestService.test.ts`, `apps/server/src/serverRuntimeStartup.ts`, `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts`, `apps/server/src/project/RepositoryIdentityResolver.test.ts`, `apps/web/src/localApi.test.ts`, `apps/server/src/provider/ProviderInstanceEnvironment.test.ts`, `apps/server/src/workspace/WorkspaceFileSystem.test.ts`, `apps/server/src/pullRequest/GitHubPullRequestCli.ts`, `apps/server/src/workspace/WorkspaceEntries.test.ts`, `apps/server/package.json`, `apps/server/src/usage/UsageService.ts`                                                                                  | Shared server and orchestration seams |
| `apps/web/src/components/RightPanelTabs.test.tsx`, `apps/web/src/keybindings.test.ts`, `apps/web/src/rightPanelStore.test.ts`, `apps/web/src/uiStateStore.test.ts`, `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/routes/_chat.pull-requests.tsx`, `apps/web/src/routes/__root.tsx`, `apps/web/src/components/LegacySidebar.tsx`, `apps/web/src/components/Sidebar.logic.ts`                                                                                                                                                                                                                                 | Shared web surfaces                   |
| `apps/desktop/src/preview/Manager.test.ts`, `apps/desktop/src/updates/DesktopUpdates.test.ts`, `apps/desktop/src/preview/Manager.ts`, `apps/desktop/src/app/DesktopEnvironment.test.ts`, `apps/desktop/src/app/DesktopEnvironment.ts`                                                                                                                                                                                                                                                                                                                                                                                                                             | Shared desktop and Electron seams     |
| `packages/client-runtime/src/state/threadReducer.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Shared packages                       |
| `README.md`, `AGENTS.md`, `docs/README.md`, `package.json`, `docs/fork/internals/scripts.md`, `docs/internals/ci.md`, `docs/internals/glossary.md`, `scripts/*.ts`, `.github/workflows/hyprws-upstream-sync.yml`, `.github/pull_request_template.md`, `docs/operations/release.md`, `docs/user/source-control.md`, `docs/user/thread-sidebar.md`, `docs/user/keybindings.md`, `apps/web/src/index.css`, `apps/desktop/src/ssh/DesktopSshPasswordPrompts.test.ts`, `apps/desktop/src/updates/updatesTestHarness.ts`                                                                                                                                                | Shared tooling, workflows, and docs   |
| `pnpm-lock.yaml`, `third-party-licenses.config.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Other shared paths                    |
| `.agents/skills/test-t3-*/**`, `apps/desktop/src/app/DesktopAppIdentity.ts`, `apps/desktop/src/app/DesktopClerk.test.ts`, `apps/desktop/src/app/DesktopConfig.ts`, `apps/desktop/src/ipc/methods/preview*.ts`, `apps/desktop/src/preview/Manager.fork.test.ts`, `apps/desktop/src/window/*.ts`, `apps/*/vite.config.ts`, `apps/web/src/browser/devAppPreviewHandoff.ts`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/hooks/useThreadActions.ts`, `apps/web/src/state/shell.ts`, `apps/web/src/state/windowProjectBootstrap.fork.ts`, `apps/web/src/state/githubIssues.ts`, `apps/web/src/lucideOptimizer.test.ts`, `scripts/lib/dev-app*.ts`, `t3.json` | `dev:app` test surfaces               |

## device-auth

### Need

- **Client:** a headless native client needs a token
- **Gap:** upstream hands tokens out by copy-paste
- **Rule:** the token never passes through a person

### Shape

An RFC 8628-style device grant, approved by the owner on the host.

1. Client: `POST /oauth/device_authorization`, optional DPoP proof
2. Owner: `t3 auth device list`, then `approve <user-code>`
3. Client: polls `POST /oauth/device_token`, receives the token

| Aspect      | Rule                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| Approval    | Host CLI only; no HTTP route can approve                                 |
| Storage     | `auth_device_authorizations` through `ForkSchema.ts`                     |
| Device code | Stored as a SHA-256 digest; single use                                   |
| Key         | A DPoP start binds the request and the session to that key               |
| Scopes      | Requested, else standard; owner `--scope` narrows only                   |
| Browsers    | Refused: CORS answers every origin, and no credential gates these routes |
| Lifetime    | `--ttl`, default 30 days; renewal is a new grant                         |
| Revocation  | The issued session, through `t3 auth session revoke`                     |
| Abuse cap   | 20 open requests; 10-minute expiry                                       |

### Retirement condition

A tagged upstream release ships owner-approved native client authorization.

### Rebase scan

| Path                                                                                                    | Why it matters              |
| ------------------------------------------------------------------------------------------------------- | --------------------------- |
| `apps/server/src/auth/DeviceAuthorization.fork.ts`, `apps/server/src/cli/authDevice.fork.ts`            | Fork-owned grant and CLI    |
| `apps/server/src/server.ts`, `apps/server/src/cli/auth.ts`, `apps/server/src/persistence/ForkSchema.ts` | Route, command, table hooks |
| `apps/server/src/auth/SessionStore.ts`, `apps/server/src/auth/dpop.ts`                                  | Reused issue and proof APIs |

## distribution

### Need

- **Releases:** upstream ships upstream code
- **Need:** a fork build and update feed
- **Runners:** the fork lacks upstream's

### Shape

| Item                                              | Role                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `.github/workflows/hyprws-ci.yml`                 | Checks, tests, trailer check, desktop build                      |
| `.github/workflows/hyprws-body.yml`               | Advisory body checks: citations, squash trailers                 |
| `.github/workflows/hyprws-release.yml`            | Human-cut stable releases plus a prerelease per `hyprws` landing |
| `scripts/fork-release-version.ts`                 | Resolves channel metadata and the previous tag in that channel   |
| `scripts/build-desktop-artifact.ts`               | Derives the update feed from `GITHUB_REPOSITORY`                 |
| `apps/desktop/src/updates/updateChannels.fork.ts` | Maps a nightly tag to the `hyprws-nightly` updater channel       |

Stable tags are `vX.Y.Z-hyprws.N`; nightlies are `vX.Y.Z-hyprws-nightly.YYYYMMDD.N`, with a six-hour changed-head check as fallback.
`hyprws-release.yml` omits upstream's `concurrency.queue: max`, because one pending slot supersedes builds the newest commit already contains.
Its release checks mirror upstream's jobs beside the build, but split packages and widen test budgets as `hyprws-ci.yml` does for GitHub-hosted runners.
Upstream workflows stay in the tree untouched and disabled, because editing or deleting them is a standing rebase conflict.
[Fork sync](../operations/fork-sync.md) owns the disable step.

### Retirement condition

Retired with the fork, or when upstream publishes builds the fork can ship unchanged.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                | Why it matters                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/desktop/src/updates/updateChannels.fork.ts`                                                                                                                                                                                                                                                                                                                                                                   | Fork-only; a conflict means upstream took the path |
| `packages/shared/src/forkVersion.ts`, `apps/web/src/versionSkew.fork.ts`, `apps/web/src/versionSkew.fork.test.ts`, `packages/shared/src/cliRelease.fork.test.ts`, `packages/ssh/src/tunnel.fork.test.ts`, `scripts/install.fork.test.ts`, `docs/fork/user/install-and-update.md`                                                                                                                                    | Fork-only; a conflict means upstream took the path |
| `apps/web/src/versionSkew.ts`, `packages/shared/src/cliRelease.ts`, `packages/shared/src/cliRelease.test.ts`, `packages/ssh/src/tunnel.test.ts`                                                                                                                                                                                                                                                                     | Shared server and orchestration seams              |
| `apps/desktop/src/updates/DesktopUpdates.fork.test.ts`, `apps/desktop/src/updates/DesktopUpdates.ts`, `apps/desktop/src/updates/updatesTestHarness.ts`                                                                                                                                                                                                                                                              | Shared desktop and Electron seams                  |
| `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/install.sh`, `scripts/resolve-nightly-release.ts`, `scripts/build-desktop-artifact.ts`, `scripts/build-desktop-artifact.test.ts`, `scripts/update-release-package-versions.ts`, `package.json`, `engines`, `packageManager`, `docs/fork/internals/scripts.md`, `README.md`, `docs/README.md`, `docs/user/install.md`, `docs/user/updating.md` | Shared tooling, workflows, and docs                |

## backend-attach

### Need

- **Service:** `t3code-backend.service`, served
- **Desktop:** always spawns its own backend
- **Result:** two writers on `state.sqlite`

### Shape

| Piece                                                | Behavior                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/desktop/src/app/DesktopBackendMode.ts`         | `managed` flips to `client-only` when `server-runtime.json` names a reachable server |
| `apps/desktop/src/app/DesktopRunningLocalServers.ts` | Discovers servers, mints a pairing URL, cross-checks environment id and origin       |
| `packages/shared/src/serverRuntimeState.ts`          | Holds the runtime state both processes read, carrying the fork's `devUrl`            |
| Client-only mode                                     | Registers no spawned primary, so the renderer has no same-origin environment         |
| `apps/web/src/connection/DesktopLocalAutoPair.tsx`   | Pairs once per launch, from an empty list and exactly one discovered server          |

A user who removes the environment on purpose is not re-paired within that session.
The launch flag and the persistent setting both come from upstream and ride here unchanged.

### Retirement condition

Retire commit by commit as upstream lands desktop attach; the live attempt is `pingdotgg/t3code#9376`.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Why it matters                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `packages/contracts/src/localServerDiscovery.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/src/settings.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Shared contracts and wire schemas     |
| `apps/server/src/cli/pair.ts`, `apps/server/src/serverRuntimeState.ts`, `apps/server/src/config.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Shared server and orchestration seams |
| `apps/web/src/connection/DesktopLocalAutoPair.tsx`, `apps/web/src/environments/primary/target.ts`, `apps/web/src/environmentPresence.ts`, `apps/web/src/routes/__root.tsx`, `apps/web/src/lib/openPullRequestLink.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Shared web surfaces                   |
| `apps/desktop/src/backend/DesktopBackendManager.ts`, `apps/desktop/src/backend/DesktopBackendConfiguration.ts`, `apps/desktop/src/app/DesktopBackendMode.ts`, `apps/desktop/src/app/DesktopRunningLocalServers.ts`, `apps/desktop/src/app/DesktopEnvironment.ts`, `apps/desktop/src/app/DesktopLifecycle.ts`, `apps/desktop/src/window/DesktopWindow.ts`, `apps/desktop/src/ipc/methods/backendMode.ts`, `apps/desktop/src/ipc/methods/localServerDiscovery.ts`, `apps/desktop/src/ipc/methods/window.ts`, `apps/desktop/src/settings/DesktopAppSettings.ts`, `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/app/DesktopConnectionCatalogStore.ts`, `apps/desktop/src/settings/DesktopClientSettings.test.ts`, `apps/desktop/src/electron/ElectronProtocol.ts`, `apps/desktop/src/app/DesktopEnvironment.test.ts`, `apps/desktop/src/app/DesktopLifecycle.test.ts`, `apps/desktop/src/backend/DesktopBackendPool.test.ts`, `apps/desktop/src/window/DesktopApplicationMenu.test.ts` | Shared desktop and Electron seams     |
| `packages/shared/src/serverRuntimeState.ts`, `packages/shared/package.json`, `packages/client-runtime/src/state/authHttp.ts`, `packages/client-runtime/src/state/auth.ts`, `packages/client-runtime/src/connection/presentation.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Shared packages                       |
| `docs/user/source-control.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Shared tooling, workflows, and docs   |

## workspace-files

### Need

- **Artifacts:** in ignored or shared scratch
- **Rule:** hidden by default, revealed on demand

### Shape

| Aspect      | Rule                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Preference  | A client-local preference includes gitignored paths on demand                                              |
| Surfaces    | The file-tree toolbar and General settings expose the same preference                                      |
| Mobile      | `ignoredWorkspaceFileListing.ts` keeps device state and reveal/reset policy behind one fork-owned boundary |
| Guard       | `mobile-ignored-file-listing` rejects inline preference or request policy in the two mobile surfaces       |
| Containment | Listing ignored paths never changes ignore rules or weakens file-read containment                          |

### Retirement condition

Upstream reveals ignored workspace paths on demand and safely reads explicitly trusted artifact links shared across worktrees.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Why it matters                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `packages/contracts/src/project.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/settings.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                   | Shared contracts and wire schemas     |
| `apps/server/src/workspace/WorkspaceEntries.ts`, `apps/server/src/vcs/GitVcsDriver.ts`, `apps/server/src/workspace/WorkspaceFileSystem.ts`, `apps/server/src/server.ts`, `apps/server/src/workspace/WorkspaceEntries.test.ts`                                                                                                                                                                                                                                                                                                                          | Shared server and orchestration seams |
| `apps/web/src/components/files/FileBrowserPanel.tsx`, `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/files/projectFilesQueryState.ts`, `apps/web/src/components/settings/settingsSearch.ts`                                                                                                                                                                                                                                                                                                                           | Shared web surfaces                   |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Shared desktop and Electron seams     |
| `apps/mobile/src/features/files/ignoredWorkspaceFileListing.ts`, `apps/mobile/src/features/files/ignoredWorkspaceFileListing.fork.test.ts`, `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx`, `apps/mobile/src/features/files/thread-file-navigator-pane.tsx`, `apps/mobile/src/features/files/FileTreeBrowser.tsx`, `apps/mobile/src/features/files/fileTree.ts`, `apps/mobile/src/features/files/fileTree.fork.test.ts`, `apps/mobile/src/features/settings/SettingsRouteScreen.tsx`, `apps/mobile/src/persistence/mobile-preferences.ts` | Shared mobile surfaces                |
| `README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Shared tooling, workflows, and docs   |

## thread-ordering

### Need

- **Groups:** related active threads together
- **Return:** back to automatic order
- **Gap:** `activeOrderKey` has no groups

### Shape

| Aspect       | Rule                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| Grouping     | Sortable-tree depth: a sideways step nests under the row above, joining its group or starting one      |
| Storage      | Membership, names, and collapsed state are client-local over `activeOrderKey`                          |
| Removal      | A member stepped back to depth 0 leaves, and a one-member group dissolves                              |
| Collapsed    | A collapsed group holds one slot: its header replaces the anchor row                                   |
| Names        | Server thread-title generation names groups; headers rename inline and dissolve                        |
| Scope        | Active, unpinned threads in the same physical project only                                             |
| Order marker | A marker below the project filter returns to automatic order; unbuilt (RSI-Software/t3code-hyprws#907) |

The fork's own manual ordering retired at `v0.0.41-nightly.20260908.1414`; what remains is grouping plus the order-mode control.

### Retirement condition

Upstream ships named thread groups with persistent membership, plus a control that returns active threads to automatic order.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                          | Why it matters                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `packages/contracts/src/environmentHttp.ts`                                                                                                                                                                                                                                                                                                                                                                                                   | Shared contracts and wire schemas     |
| `apps/server/src/orchestration/ThreadGroupTitles.ts`, `apps/server/src/orchestration/http.ts`                                                                                                                                                                                                                                                                                                                                                 | Shared server and orchestration seams |
| `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/components/Sidebar.logic.test.ts`, `apps/web/src/components/Sidebar.logic.fork.test.ts`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/SidebarThreadGroup.tsx`, `apps/web/src/components/SidebarRenameInput.tsx`, `apps/web/src/state/threadGroups.ts`, `apps/web/src/uiStateStore.ts`, `apps/web/src/uiStateStore.test.ts`, `apps/web/src/connection/runtime.ts` | Shared web surfaces                   |
| `packages/client-runtime/src/state/threadGroups.ts`, `packages/client-runtime/src/state/threadGroupTitleHttp.ts`, `packages/client-runtime/package.json`                                                                                                                                                                                                                                                                                      | Shared packages                       |
| `docs/user/thread-sidebar.md`                                                                                                                                                                                                                                                                                                                                                                                                                 | Shared tooling, workflows, and docs   |

## thread-fork

### Need

- **Fork:** a thread continues as a copy
- **Same:** provider instance and native session

### Shape

**Fork thread** in a thread's menu fires `thread.fork`; the sidebar and header menus share one dispatch that navigates to the child.

The server handler drives the import pipeline's own commands:

1. Guard: quiescent, no pending requests
2. Guard: usable cursor, not deleted or archived
3. Binding insert-ignore
4. `thread.create` with `historyImport: true`
5. `thread.history.import`, fresh `import:` ids
6. `thread.unsettle`

| Aspect    | Rule                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Claude    | Eager native fork at click; child cursor seeded from the clone's human-prompt UUIDs                         |
| Codex     | Lazy fork at the child's first start (`thread/fork` from the source's latest completed turn)                |
| Cursor    | Handler writes it, runtime reads it; the runtime's fork branch fails closed with no `thread/start` fallback |
| Parent    | Binding and cursor are read-only during a fork; the source thread is never rewritten                        |
| Providers | Claude and Codex only; every other driver refuses with `ThreadForkUnsupportedProviderError`                 |

Tracked by RSI-Software/t3code-hyprws#1310.
`ClaudeHistoryCommand.fork.ts` mirrors `runScopedHistoryCommand` in `ClaudeAdapter.ts` on purpose: rebase safety beats DRY.

### Retirement condition

A tagged upstream release ships same-provider thread fork for Claude and Codex.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                     | Why it matters                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `packages/contracts/src/threadFork.fork.ts`, `packages/contracts/src/rpc.fork.ts`, `packages/contracts/src/rpc.ts`                                                                                                                                                                                                                       | Shared contracts and wire schemas |
| `apps/server/src/project/ThreadFork.fork.ts`, `apps/server/src/ws.ts`, `apps/server/src/auth/RpcAuthorization.ts`                                                                                                                                                                                                                        | Handler, wiring, and auth scope   |
| `apps/server/src/provider/Layers/ClaudeHistoryCommand.fork.ts`, `apps/server/src/provider/Layers/ClaudeThreadFork.fork.ts`                                                                                                                                                                                                               | Claude fork path                  |
| `apps/server/src/provider/Layers/CodexThreadFork.fork.ts`, `apps/server/src/provider/Layers/CodexSessionRuntime.ts`                                                                                                                                                                                                                      | Codex fork-on-open path           |
| `apps/web/src/state/threadFork.fork.ts`, `apps/web/src/components/threadActionMenu.logic.fork.ts`, `apps/web/src/components/threadActionMenu.logic.ts`, `apps/web/src/hooks/useThreadActionMenu.ts`, `apps/web/src/hooks/useThreadActionMenu.fork.ts`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/contextMenuFallback.fork.ts` | Shared web surfaces               |

## upstream-fixes

### Need

- **Scope:** fixes belonging to no domain
- **Place:** stack bottom, each drops alone
- **Exit:** upstream fixes it, the commit goes

### Shape

| Aspect  | Rule                                                                              |
| ------- | --------------------------------------------------------------------------------- |
| Commit  | One upstream-native commit per fix, `Fork-Tier: bugfix`, `Fork-Upstreamable: yes` |
| Lane    | Created from `upstream/main`, so the fix carries no fork dependency               |
| Helpers | None shared across fixes; each must drop alone                                    |

### Terminal focus contract

Three commits share one behavior contract while each still drops alone, so a rebase that drops one re-checks the other two.

| Aspect         | Contract                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- |
| Keys           | Jump, previous/next, and palette keys switch threads from a focused terminal; others stay |
| Navigation     | Thread navigation always lands in the composer                                            |
| Terminal focus | Taken only on explicit request; returning and closing both land in the composer           |
| Focus ring     | The focused pane shows a static ring, never an animation                                  |

Proof: `apps/web/src/components/ThreadTerminalDrawer.test.ts`, `ChatView.logic.test.ts`, and a Chrome pass on each landing.

### Retirement condition

Per commit: upstream ships the fix, and the next rebase drops the commit.
The domain retires when it is empty.

### Rebase scan

| Path                           | Why it matters                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `native/libghostty-vt/VERSION` | Moved: rebuild `ghostty-sprite.wasm`; Ghostty `76e568b` or later needs a `global.zig` stub and Zig 0.16 |
| `**`                           | Other shared paths                                                                                      |

## zmux-estate

### Need

- **Estate:** terminal and worktree in zmux
- **Gap:** upstream owns no session manager

### Shape

| Aspect    | Rule                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------ |
| Switch    | `terminalSessionMode`; `"zmux"` attaches terminals and adopts worktrees, verified by `session resolve` |
| Ownership | The physical checkout owns its managed session; threads are consumers                                  |
| Cleanup   | T3 snapshots a session identity and hands it back for conditional removal                              |
| Refusal   | A refused or shared-viewer removal preserves every viewer and reports partially                        |
| Fallback  | Each plain-shell fallback prints its reason; a missing binary degrades silently                        |
| Legacy    | `zmuxSessions` folds into `terminalSessionMode` on load                                                |
| Binder    | `apps/server/src/zmux/`, called through `ProcessRunner` with tmux variables stripped                   |

**Demand leases.** Visible terminal surfaces hold them: web on document visibility, Electron on each shown, non-minimized window, deliberately excluding focus.
Electron cannot observe Hyprland workspace occlusion, so a shown window on an inactive workspace still holds demand.
Client streams release immediately, then a server-owned grace timer detaches only the `zmux open` PTY.
Resume re-resolves the thread's persisted checkout, so renames follow the verified target.

**Checkout moves.** A thread moves between existing checkouts through a durable requested and effective transition, queued behind active turns and serialized by ordered checkout leases.
A move relocates a provider only when that thread already has a live runtime; a dormant thread moves metadata and records a null effective checkout.
Partial failures retain provider availability and the observed effective checkout.
A turn start on a thread whose worktree is gone runs a recovery move to the project root inline, bypassing only that thread's own pending turn.
Terminal follow and pin stay client-owned, and move state carries no attachment identities.

**Persistence.** Checkout move state rides on the V2 thread payload through `thread.metadata.update`, so it needs no fork column; `apps/server/src/persistence/ForkSchema.ts` only clears the stale migration record a V1 build left behind.
Managed suspension stays internal, and released clients decode it through the optional `attachmentStatus` sibling.

### Retirement condition

Upstream terminals attach to an operator-chosen external session manager, and worktree lifecycle exposes hooks it can bind to.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Why it matters                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/server/src/terminal/ManagedAttachmentLifecycle.ts`, `apps/web/src/state/terminalAttachmentRetention.fork.ts`, `apps/server/src/zmux/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Fork-only; a conflict means upstream took the path |
| `packages/contracts/src/terminal.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/git.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/src/settings.test.ts`, `packages/contracts/src/orchestration.ts`, `packages/contracts/src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Shared contracts and wire schemas                  |
| `apps/server/src/terminal/Manager.ts`, `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/runtimeLayer.ts`, `apps/server/src/orchestration-v2/ThreadLaunchService.ts`, `apps/server/src/server.ts`, `apps/server/src/ws.ts`, `apps/server/src/git/GitManager.ts`, `apps/server/src/git/GitManager.test.ts`, `apps/server/src/serverSettings.ts`, `apps/server/src/serverSettings.test.ts`, `apps/server/src/processRunner.ts`, `apps/server/src/git/CheckoutMutationCoordinator.ts`, `apps/server/src/project/AgentSessionImporter.test.ts`, `apps/server/src/persistence/ForkSchema.ts`, `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` | Shared server and orchestration seams              |
| `apps/web/src/components/ThreadTerminalDrawer.tsx`, `apps/web/src/components/onboarding/WelcomeWizard.tsx`, `apps/web/src/state/terminalSessions.ts`, `apps/web/src/state/terminalSessions.test.ts`, `apps/web/src/state/terminalAttachmentRetention.fork.test.ts`, `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/ThreadTerminalDrawer.test.ts`, `apps/web/src/components/settings/settingsSearch.ts`, `apps/web/src/state/entities.ts`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/BranchToolbarBranchSelector.tsx`, `apps/web/src/components/BranchToolbarBranchSelector.fork.ts`, `apps/web/src/components/BranchToolbar.logic.fork.ts`, `apps/web/src/terminal/ghostty/surface.ts`                                                       | Shared web surfaces                                |
| `apps/desktop/src/window/DesktopWindow.ts`, `apps/desktop/src/preview/WindowPolicy.preload.ts`, `apps/desktop/src/ipc/channels.ts`, `apps/desktop/src/window/DesktopWindow.test.ts`, `apps/desktop/src/preload.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Shared desktop and Electron seams                  |
| `apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx`, `apps/mobile/src/persistence/mobile-preferences.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Shared mobile surfaces                             |
| `packages/client-runtime/src/state/terminal.ts`, `packages/client-runtime/src/state/runtime.test.ts`, `packages/client-runtime/src/operations/checkoutMove.fork.ts`, `packages/client-runtime/src/operations/commands.ts`, `packages/client-runtime/src/state/threadCommands.ts`, `packages/client-runtime/src/state/checkoutMove.ts`, `packages/client-runtime/package.json`                                                                                                                                                                                                                                                                                                                                                                                                                        | Shared packages                                    |
| `docs/architecture/terminal-renderers.md`, `docs/user/source-control.md`, `docs/internals/terminal-runtime.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Shared tooling, workflows, and docs                |

## worktrunk-hooks

### Need

- **Parity:** with `wt switch --create`
- **Hooks:** `.config/wt.toml` on create and remove
- **Gap:** upstream calls Git directly

### Shape

| Aspect          | Rule                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| Mode            | `ThreadEnvMode` gains `worktrunk`, labelled "New worktrunk"; upstream's `worktree` is untouched      |
| Wire            | `worktrunk` never crosses the wire; an optional `defaultThreadEnvModeFork` sibling carries it        |
| Storage         | Events, projection, and `t3.json` keep the wide mode; `settings.json` migrates on read               |
| Marker          | The first turn drops a `t3-worktrunk` marker in the worktree gitdir                                  |
| Hooks           | `pre-start` and `post-start` run before the setup script; `post-remove` runs in the primary checkout |
| Marker lifetime | `git worktree remove` deletes it, so no thread or project state records the mode                     |
| Hook execution  | Headless through `wt hook <type> --yes`; a failed create hook lands as error activity                |
| Gating          | `.config/wt.toml` and `wt` on PATH; without either the mode degrades to `worktree`                   |
| Unsupported     | Pull-request threads, and mobile, which maps a `worktrunk` default to a worktree                     |
| Paths           | Worktree paths stay T3 Code's; the fork never delegates to `wt switch` or `wt remove`                |
| Runner          | `apps/server/src/worktrunk/`, called through `ProcessRunner` with tmux variables stripped            |
| Persistence     | No column. A future one needs the idempotent `ForkSchema.ts` pattern                                 |

Local VCS status reports `worktrunk: true` while the marker exists, which is how a started thread's composer reads "Worktrunk".

### Retirement condition

Upstream worktree lifecycle exposes create and remove hooks a project can bind shell commands to.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Why it matters                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `apps/server/src/worktrunk/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Fork-only; a conflict means upstream took the path |
| `packages/contracts/src/environment.ts`, `packages/contracts/src/orchestration.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/settings.test.ts`, `packages/contracts/src/git.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Shared contracts and wire schemas                  |
| `apps/server/src/provider/Drivers/AntigravityDriver.ts`, `apps/server/src/serverSettings.ts`, `apps/server/src/orchestration-v2/ProjectStore.ts`, `apps/server/src/orchestration-v2/ThreadLaunchService.ts`, `apps/server/src/ws.ts`, `apps/server/src/server.ts`, `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/git/GitManager.ts`, `apps/server/src/git/GitManager.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Shared server and orchestration seams              |
| `apps/web/src/hooks/useHandleNewThread.ts`, `apps/web/src/components/BranchToolbar.logic.ts`, `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`, `apps/web/src/components/BranchToolbarBranchSelector.tsx`, `apps/web/src/components/BranchToolbar.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/ChatView.logic.ts`, `apps/web/src/composerDraftStore.ts`, `apps/web/src/lib/chatThreadActions.ts`, `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/settings/settingsSearch.ts`, `apps/web/src/components/settings/settingsSearch.test.ts`, `apps/web/src/components/settings/ProjectSettingsPanel.tsx`, `apps/web/src/components/GitActionsControl.tsx`, `apps/web/src/components/settings/SettingInheritance.tsx`, `apps/web/src/components/settings/scopedSettings.ts`, `apps/web/src/components/settings/scopedSettings.test.ts` | Shared web surfaces                                |
| `apps/mobile/src/features/threads/new-task-flow-provider.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Shared mobile surfaces                             |
| `packages/shared/src/threadEnvMode.ts`, `packages/shared/src/serverSettings.ts`, `packages/shared/src/projectSettings.ts`, `packages/shared/src/projectSettings.test.ts`, `packages/shared/package.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Shared packages                                    |

## Adding a domain

A new domain needs a section with the same four headings, a row in the domain index, and a name to carry as `Fork-Domain`.

| #   | Question                                                |
| --- | ------------------------------------------------------- |
| 1   | What does upstream not do, stated as behavior?          |
| 2   | What would upstream ship for this domain to be deleted? |
| 3   | Which upstream paths does it touch?                     |

If the third answer is "many files across unrelated systems", it is probably a bugfix under `upstream-fixes`.
Keep its new code in its own files, and follow [Extracting a domain](./fork-development.md#extracting-a-domain).
