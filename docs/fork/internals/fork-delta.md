# Fork delta

Each fork domain's need, shape, retirement condition, and rebase scan.
[Fork development](./fork-development.md) owns the discipline.

```bash
vp run fork:delta           # ledger grouped by domain and tier
vp run fork:delta --check   # exit 1 on a missing or invalid trailer
vp run fork:delta --json    # the same ledger for tooling
vp run fork:delta --inventory --upstream vX.Y.Z # overlap stats per domain
```

## Rebase scans

Each domain's **Rebase scan** table lists the **upstream paths** its commits touch.

```bash
vp run fork:scan                    # every domain against live upstream/main
vp run fork:scan --target vX.Y.Z    # the same walk pinned to a tag
```

`fork:scan` **fails** when a domain's commits change a file its table omits and **upstream also changed** it.
Every code span in a Path cell is **one pattern**: `*` stays inside a segment, `**` spans them.

Fork CI runs it as a **blocking** check:

- **Every push**, against its upstream merge base
- On `sync/candidate`, against the **target tag**

## Tiers

| Tier     | Meaning                                  | On retirement                       |
| -------- | ---------------------------------------- | ----------------------------------- |
| `core`   | The domain does not work without it      | Deleted with the domain             |
| `qol`    | Polish; the domain works without it      | Reassess individually               |
| `bugfix` | A defect fix; note upstream reproduction | Dropped once upstream supersedes it |

A `bugfix` upstream reproduces is a **retire candidate**: wait for upstream's fix, then drop it at the next rebase.
Every signalled commit gets **one retirement outcome** during the rebase.
The **retire commit itself** records a retirement; no ledger does.

## Trailers

| Trailer             | Values                  | Required on       |
| ------------------- | ----------------------- | ----------------- |
| `Fork-Domain`       | A `FORK_DOMAINS` value  | Every fork commit |
| `Fork-Tier`         | `core`, `qol`, `bugfix` | Every fork commit |
| `Fork-Upstreamable` | `yes`, `no`             | Every `bugfix`    |

`FORK_DOMAINS` lives in [`scripts/lib/fork-trailers.ts`](../../../scripts/lib/fork-trailers.ts).
`Fork-Upstreamable: yes` is a **tracking tag**, never authorization to post upstream; `AGENTS.md` owns that rule.
`vp run fork:delta --check` **enforces** the table on every push; a rebase preserves trailers.

The advisory `hyprws Body` workflow runs `--check --squash-body <file>` on the **PR body's final trailer paragraph**, which becomes the squash trailers.
A trailer carried **only by a branch commit** cannot satisfy it.

## Carry cost

Each commit is **retired, reshaped, automated, or accepted**; no gate carries a numeric cap.
**Accept is never "as-is"**: fork code sits in **fork-only files**, and upstream files carry only **marked hook lines** the walk re-applies.

### Marking a hook

A statement takes a **trailing marker**: `// fork-hook: <domain>/<name>` or `/* fork-hook: … */`.
Multi-line JSX takes a **marker pair**: `{/* fork-hook: <domain>/<name> */}` and `{/* fork-hook-end */}`.

A hook is **exactly one construct**: one import, one call, one `const` from a single fork call, one JSX element, one fork-named property or spread, or one re-export.
A hook **never removes or modifies an upstream line**, not even to re-indent or substitute one.
`reapplyHooks` in `scripts/fork-sync.ts` accepts **only a pure insertion**: the fork side minus its marked spans equals the base minus the earlier hooks this commit leaves unchanged.
Any other shape **stops every sync** touching the file, and the hook guard misses it because it checks only added lines.
Move such logic into a **`*.fork.ts` sibling** and leave one marked call.

A trailing marker **covers the whole statement** it closes.
`statementStartLine` in `scripts/lib/fork-hooks.ts` walks back from the marker; at the statement's own depth, the line above:

- **Continues** it inside an open bracket or literal
- **Stops** it ending in `;`, `{`, `,`, or `}`
- **Stops** it when blank or comment-only

The hook guard, `scripts/lib/fork-hook-guard.ts`, **refuses every added line** outside the span, so comment placement decides:

| Comment                   | Span                      | Guard   |
| ------------------------- | ------------------------- | ------- |
| Above the hook            | starts below the comment  | refuses |
| Between `=>` and the body | starts at the body        | refuses |
| Inside the call arguments | open bracket: walk passes | accepts |

## Domain index

A domain is **a reason the fork exists**, not a feature area; each section states its **retirement condition**.

- [multi-window](#multi-window)
- [workspaces](#workspaces)
- [browser-bookmarks](#browser-bookmarks)
- [backend-attach](#backend-attach)
- [github-issues](#github-issues)
- [thread-artifacts](#thread-artifacts)
- [custom-agents](#custom-agents)
- [device-auth](#device-auth)
- [markdown-editing](#markdown-editing)
- [workspace-files](#workspace-files)
- [fork-meta](#fork-meta)
- [distribution](#distribution)
- [upstream-fixes](#upstream-fixes)
- [thread-ordering](#thread-ordering)
- [thread-fork](#thread-fork)
- [zmux-estate](#zmux-estate)
- [worktrunk-hooks](#worktrunk-hooks)
- [delegated-rounds](#delegated-rounds)
- [voice-input](#voice-input)
- [colleague-collab](#colleague-collab)

## multi-window

### Need

- **Many windows**, one shared backend
- An **opaque window id**, stable across restore

### Shape

A **window registry** keyed by an opaque `WindowId`, with sender-owned dispatch and a per-window manifest restore.

| Seam     | Fork boundary                                   |
| -------- | ----------------------------------------------- |
| Identity | `WindowId` minted in main, a preload argument   |
| Dispatch | `main` consumers resolve to sender or latest    |
| Requests | `WindowDispatch.fork.ts`: create, reuse, focus  |
| Startup  | Bounded intent queue, drained at renderer load  |
| Restore  | Manifest v2: id, route, bounds, workspace       |
| Scope    | Sidebar project scope per `WindowId`            |
| Legacy   | `legacyProjectLink.fork.ts` decodes old links   |
| Drafts   | `projectDraftMigration.fork.ts` folds them once |
| Provider | Env names the project and thread, never window  |

`$XDG_RUNTIME_DIR/t3code/windows-<pid>.json` **maps each Hyprland address** to its project scope.
**Hyprland places windows**; update restore only returns each to its recorded workspace, a no-op off Hyprland.

### Retirement condition

Upstream ships its own multi-window support.
Browser-mode parity with Electron also retires it: plain browser windows or a small Electron shell then suffice.

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
| `packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`, `package.json`, `docs/user/keybindings.md`, `docs/user/thread-sidebar.md`                                                                                                                                                                                                                                                                                                                                                                                | Keybindings and docs                      |

## workspaces

### Need

- Each window shows **its own project set**
- A **chooser** picks the window's projects
- Scope **narrows lists**, never hides work

### Shape

A **per-window project filter**, `useWindowProjectFilter()`, projects selected refs into upstream's `scopedProjectKeys`.
It is **client-local**, with no wire change.
It is stored per `WindowId` on desktop, per tab in `sessionStorage` on web, and as a device preference on mobile.
A **small adapter** wraps upstream's single-select scope combobox.
The scope **governs** palette search, the new-thread target, outside-thread add, and the window title.

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

- **Durable** browser **shortcuts**
- Scoped **per project** and **per profile**

### Shape

- **One global** and **per-project** collections
- **Star** saves, moves, or removes a page
- **New tab** lists Project, Global, then recents
- **Store** normalizes, dedupes, caps, watches
- **No server** contract and **no IPC**

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

- **Browse issues** on web and desktop
- **Hand off** one issue, window-scoped

### Shape

- **Server** lists, details, closes, reopens
- **Lists degrade** per project, keep identity
- **Web** routes, filters, comments, tabs
- **Hand-off** opens an unsent templated draft
- **Palette** gains Issues, with no PR twin

The settings search item **stays in `githubIssueSettingsSearch.ts`**, never in the upstream registry.

### Thread links

- Threads **persist** linked issues
- Agents **link, unlink, list** over MCP
- A **`ForkSchema.ts` pass**, never a migration
- **Shell refetch** carries the links live
- **No issue events** in detail; old-client safe
- An **older snapshot** never wins
- Snapshots carry **sub-issues, parent, type, and labels**
- **Older servers reject** link events

The client-only UI **mirrors linked pull requests** on each of their surfaces.

### Retirement condition

| Upstream ships                           | Action                                    |
| ---------------------------------------- | ----------------------------------------- |
| Issues list, detail, close, and hand-off | Delete the service and UI                 |
| The core service only                    | Keep the scope adapter under `workspaces` |

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why it matters                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `packages/client-runtime/src/state/sharedSettings.ts`, `packages/contracts/src/githubIssue.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/orchestration.ts`, `packages/contracts/src/environment.ts`, `packages/contracts/src/environment.test.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/settings.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Shared contracts and wire schemas     |
| `apps/server/src/githubIssue/**`, `apps/server/src/sourceControl/GitHubCli.ts`, `apps/server/src/ws.ts`, `apps/server/src/server.ts`, `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts`, `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts`, `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/environment/ServerEnvironment.ts`, `apps/server/src/environment/ServerEnvironment.test.ts`, `apps/server/src/pullRequest/PullRequestService.ts`, `apps/server/src/pullRequest/PullRequestService.test.ts`, `apps/server/src/mcp/McpHttpServer.ts`, `apps/server/src/provider/RuntimeInstructions.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Shared server and orchestration seams |
| `apps/web/src/routes/_chat.issues.tsx`, `apps/web/src/routes/project.$environmentId.$projectId.issues.tsx`, `apps/web/src/components/githubIssue/githubIssueRouteSearch.ts`, `apps/web/src/components/githubIssue/GitHubIssueDetailPanel.tsx`, `apps/web/src/components/settings/GitHubIssueSettings.tsx`, `apps/web/src/components/settings/githubIssueSettingsSearch.ts`, `apps/web/src/components/settings/githubIssueSettingsSearch.fork.test.ts`, `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts`, `apps/web/src/rightPanelStore.ts`, `apps/web/src/components/RightPanelTabs.tsx`, `apps/web/src/rightPanelStore.test.ts`, `apps/web/src/components/RightPanelTabs.test.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/lib/openPullRequestLink.ts`, `apps/web/src/lib/openPullRequestLink.test.ts`, `apps/web/src/components/sidebar/SidebarChrome.tsx`, `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/components/ChatMarkdown.test.tsx`, `apps/web/src/components/CommandPalette.logic.ts`, `apps/web/src/components/CommandPalette.logic.test.ts`, `apps/web/src/components/settings/SourceControlSettings.tsx`, `apps/web/src/components/settings/settingsSearch.ts`, `apps/web/src/routes/_chat.pull-requests.tsx`, `apps/web/src/state/pullRequests.ts`, `apps/web/src/routeTree.gen.ts`, `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`, `apps/web/src/components/sidebar/SidebarThreadRow.tsx`, `apps/web/src/components/BranchToolbarBranchSelector.tsx` | Shared web surfaces                   |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Shared desktop and Electron seams     |
| `packages/client-runtime/src/state/githubIssues.ts`, `packages/client-runtime/package.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Shared packages                       |
| `docs/user/source-control.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Shared tooling, workflows, and docs   |

## thread-artifacts

### Need

- **Keep** agent-written documents by the thread
- Edits show **without a new message**
- **Any host path**, scratch folders included

### Shape

Links live **on the thread shell**; T3 **never creates or deletes** the files.
They ride `thread.metadata-updated`; `artifacts` is **omitted when empty**, so stock clients see no change.
Clients send `thread.artifact.link` and `unlink`; **only the server** sends `observe`, which never bumps the thread's `updatedAt`.
`ArtifactWatchReactor.fork.ts` **watches parent directories**, so rename-on-save still reports.
Previews **reuse the file panel**; HTML is **served raw**, with no `html_render` theme bootstrap.

### Retirement condition

A tagged upstream release links agent-written documents to threads and keeps them current.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                            | Why it matters                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/index.ts`, `packages/client-runtime/src/state/models.ts`                                                                                                                                                                                                                   | Command unions and thread shell field              |
| `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts`                                                                                                                                                                   | Dispatch and projection seams                      |
| `apps/server/src/server.ts`, `apps/server/src/mcp/McpHttpServer.ts`, `packages/provider-core/src/server/runtimeInstructions.ts`                                                                                                                                                                                                                 | Watcher layer, toolkit, instruction line           |
| `apps/web/src/rightPanelStore.ts`, `apps/web/src/rightPanelStore.test.ts`, `apps/web/src/components/RightPanelTabs.tsx`, `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/sidebar/SidebarThreadRow.tsx`, `apps/web/src/components/BranchToolbarBranchSelector.tsx` | Shared web surfaces                                |
| `packages/provider-core/src/server/RuntimeInstructions.fork.ts`, `apps/server/src/provider/agentContextOverhead.fork.ts`, `apps/server/src/provider/RuntimeInstructions.fork.test.ts`, `apps/server/src/orchestration-v2/testkit/ReplayRuntimeInstructions.fork.ts`, `apps/server/src/orchestration-v2/ConversationFork.fork.test.ts`           | Fork files shared with other domains               |
| `packages/contracts/src/threadArtifacts.fork.ts`, `apps/server/src/orchestration-v2/ThreadArtifacts.fork*.ts`, `apps/server/src/artifacts/**`, `apps/server/src/mcp/toolkits/artifacts/**`, `apps/web/src/components/threadArtifacts/**`, `docs/fork/user/thread-artifacts.md`                                                                  | Fork-only; a conflict means upstream took the path |

## custom-agents

### Need

- A **custom agent** as the main thread
- Upstream **exposes models only**

### Shape

Provider model capabilities carry an **`agent` select descriptor**, declared in the two `*AgentOptions.fork.ts`.

| Provider | Inventory                       | Applied as                                     |
| -------- | ------------------------------- | ---------------------------------------------- |
| Claude   | Agent SDK initialization result | the `--agent` launch argument                  |
| Codex    | `<CODEX_HOME>/agents/*.toml`    | `thread/start` or `thread/resume` config layer |

- **Project** beats personal **by name**
- **Persists** in `modelSelection.options`
- A **change restarts** the provider session
- The panel shows **one roster** of child work

An **unsupported provider** reports child detail as unavailable, never an inert row.

### Retirement condition

Upstream discovers and selects provider-native main-thread agents for Claude and Codex, persisting the selection across new and resumed sessions.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why it matters                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `packages/contracts/src/model.ts`, `packages/shared/src/model.ts`, `packages/contracts/src/orchestration.ts`, `packages/contracts/src/environmentHttp.ts`, `packages/contracts/src/providerRuntime.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Shared contracts and wire schemas     |
| `apps/server/src/provider/Layers/ClaudeProvider.ts`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `apps/server/src/provider/Drivers/CodexAgents.ts`, `apps/server/src/provider/Layers/CodexProvider.ts`, `apps/server/package.json`, `pnpm-lock.yaml`, `apps/server/src/checkpointing/CheckpointDiffQuery.test.ts`, `apps/server/src/project/ProjectSetupScriptRunner.test.ts`, `apps/server/src/provider/Drivers/CodexDriver.ts`, `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts`, `apps/web/src/keybindings.fork.test.ts`, `apps/web/src/uiStateStore.fork.test.ts`, `apps/server/src/serverRuntimeStartup.test.ts`, `apps/server/src/project/AgentSessionScanner.test.ts` | Shared server and orchestration seams |
| `apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/AgentsPanel.tsx`, `apps/web/src/components/AgentDetailPanel.tsx`, `apps/web/src/rightPanelStore.ts`, `apps/web/src/components/chat/MessagesTimeline.tsx`, `apps/web/src/components/chat/AgentSpawnNavigation*`, `apps/web/src/rightPanelStore.test.ts`, `apps/web/src/components/chat/composerProviderState.test.tsx`, `apps/web/src/connection/runtime.ts`, `apps/web/src/providerModels.ts`                                                                                                                                                                                                                                                                  | Shared web surfaces                   |
| `apps/mobile/src/lib/threadActivity.ts`, `apps/mobile/src/lib/threadActivity.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Shared mobile surfaces                |
| `packages/client-runtime/package.json`, `packages/client-runtime/src/state/orchestration.ts`, `packages/client-runtime/src/state/threadReducer.ts`, `packages/client-runtime/src/state/subagentRuntime.ts`, `packages/client-runtime/src/state/subagentRuntime.test.ts`, `packages/client-runtime/src/state/subagentDetail.ts`, `packages/client-runtime/src/state/agentActivityHttp.ts`, `packages/client-runtime/src/state/threadReducer.test.ts`                                                                                                                                                                                                                                                                                                                              | Shared packages                       |
| `docs/user/providers-codex.md`, `docs/user/providers-claude.md`, `README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Shared tooling, workflows, and docs   |

## markdown-editing

### Need

- Upstream has **preview and source**, never rich
- **Edit rendered**, save Markdown

### Shape

- **Rich and Source** modes for `.md`
- **Lazy Milkdown** with GFM and frontmatter
- **Saves** through the cache and save sessions
- **Excludes** MDX and truncated files
- Raw HTML **sanitized**, `@scope`d, contained
- **Granular `@milkdown/*`** packages only

`richMarkdownDependencies.fork.test.ts` **pins the manifest**; never `@milkdown/react`, which pulls `@milkdown/crepe`, a Vue runtime, and CodeMirror.
Editor imports and inline rich surfaces **stay out of `FilePreviewPanel`**.
In a historical repair, **derive the lockfile** from the accepted manifests with `vp i`.

### Retirement condition

Upstream ships rich Markdown editing with safe frontmatter and MDX boundaries, on the existing save path, loading no editor bundle during ordinary browsing.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Why it matters                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `apps/web/src/components/files/MarkdownRichEditor.tsx`, `apps/web/src/components/files/markdown-rich-editor.css`, `packages/shared/src/markdownStyledHtml.fork.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Fork-only; a conflict means upstream took the path |
| `apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/files/fileSaveCoordinator.ts`, `apps/web/src/components/files/fileSaveSessions.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Shared web surfaces                                |
| `apps/web/src/components/files/FilePreviewPanel.tsx`, `apps/web/src/components/files/RichMarkdownPreviewBoundary.tsx`, `apps/web/src/components/files/RichMarkdownPreviewBoundary.fork.test.ts`, `apps/web/src/components/files/markdownPipeline.ts`, `markdownPipeline.test.ts`, `apps/web/src/components/files/markdownEditorPresentation.ts`, `apps/web/src/components/files/richMarkdownEditorLinks.ts`, `apps/web/src/components/files/richMarkdownEditorLinks.fork.test.ts`, `apps/web/src/components/files/markdownFrontmatter.ts`, `markdownSerializerFixes.ts`, `apps/web/src/components/files/richMarkdownDependencies.fork.test.ts`, `apps/web/package.json`, `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/components/files/FileMarkdownPreview.tsx`, `packages/shared/package.json` | Shared web surfaces                                |
| `docs/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Shared tooling, workflows, and docs                |
| `pnpm-lock.yaml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Other shared paths                                 |

## fork-meta

### Need

- **Fork docs**, conventions, and tooling
- Keeps **meta out of** a domain

### Shape

It owns the **fork sections** of `README.md`, `AGENTS.md`, and `docs/README.md`, plus this document, [Fork development](./fork-development.md), and [Fork sync](../operations/fork-sync.md).
It owns `scripts/fork-*.ts`; each **hand-run one gets** a `fork:*` alias.
It owns the [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill and the `hyprws-upstream-sync.yml` and `hyprws-sync-resolution.yml` workflows.
The PR template's trailer block **points to `FORK_DOMAINS`** for the domain list.
`.rsi-agent/workflows/*.md` are rsi-pr-agent **copies** of `.macroscope/check-run-agents/`, each **pinned** as a [workflow copy](../operations/fork-sync.md#workflow-copies).
Every fork workflow checkout that runs rebased code **scrubs its persisted credential** first, as `hyprws-upstream-sync.yml` does.

### Retirement condition

Retired with the fork.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why it matters                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `packages/contracts/src/settings.test.ts`, `apps/web/src/components/ChatView.logic.test.ts`, `apps/web/src/components/Sidebar.logic.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                     | Shared contracts and wire schemas                        |
| `apps/server/src/pullRequest/PullRequestService.test.ts`, `apps/server/src/serverRuntimeStartup.ts`, `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts`, `apps/server/src/project/RepositoryIdentityResolver.test.ts`, `apps/web/src/localApi.test.ts`, `apps/server/src/provider/ProviderInstanceEnvironment.test.ts`, `apps/server/src/workspace/WorkspaceFileSystem.test.ts`, `apps/server/src/pullRequest/GitHubPullRequestCli.ts`, `apps/server/src/workspace/WorkspaceEntries.test.ts`, `apps/server/package.json`, `apps/server/src/usage/UsageService.ts` | Shared server and orchestration seams                    |
| `apps/web/src/components/RightPanelTabs.test.tsx`, `apps/web/src/keybindings.test.ts`, `apps/web/src/rightPanelStore.test.ts`, `apps/web/src/uiStateStore.test.ts`, `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/routes/_chat.pull-requests.tsx`, `apps/web/src/routes/__root.tsx`, `apps/web/src/components/LegacySidebar.tsx`, `apps/web/src/components/Sidebar.logic.ts`                                                                                                                                                | Shared web surfaces                                      |
| `apps/desktop/src/preview/Manager.test.ts`, `apps/desktop/src/updates/DesktopUpdates.test.ts`, `apps/desktop/src/preview/Manager.ts`, `apps/desktop/src/app/DesktopEnvironment.test.ts`, `apps/desktop/src/app/DesktopEnvironment.ts`                                                                                                                                                                                                                                                                                                                                            | Shared desktop and Electron seams                        |
| `packages/client-runtime/src/state/threadReducer.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Shared packages                                          |
| `README.md`, `AGENTS.md`, `docs/README.md`, `package.json`, `docs/fork/internals/scripts.md`, `docs/internals/ci.md`, `docs/internals/glossary.md`, `scripts/*.ts`, `.github/workflows/hyprws-upstream-sync.yml`, `.github/pull_request_template.md`, `docs/operations/release.md`, `docs/user/source-control.md`, `docs/user/thread-sidebar.md`, `docs/user/keybindings.md`, `apps/web/src/index.css`, `apps/desktop/src/ssh/DesktopSshPasswordPrompts.test.ts`, `apps/desktop/src/updates/updatesTestHarness.ts`                                                               | Shared tooling, workflows, and docs                      |
| `apps/server/src/provider/AgentContextBudget.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Exact context accounting for the existing fork footprint |
| `pnpm-lock.yaml`, `third-party-licenses.config.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Other shared paths                                       |
| `apps/desktop/src/app/DesktopAppIdentity.ts`, `apps/desktop/src/app/DesktopClerk.test.ts`, `apps/desktop/src/app/DesktopConfig.ts`, `apps/desktop/src/ipc/methods/preview*.ts`, `apps/desktop/src/preview/Manager.fork.test.ts`, `apps/desktop/src/window/*.ts`, `apps/*/vite.config.ts`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/hooks/useThreadActions.ts`, `apps/web/src/state/shell.ts`, `apps/web/src/state/windowProjectBootstrap.fork.ts`, `apps/web/src/state/githubIssues.ts`, `apps/web/src/lucideOptimizer.test.ts`                                     | Dev desktop and window seams                             |

## device-auth

### Need

- A **headless native client** needs a token
- Upstream hands tokens out **by copy-paste**
- The token **never passes through a person**

### Shape

An **RFC 8628-style device grant**, approved by the owner on the host:

1. Client **requests** a grant, optionally DPoP
2. Owner **approves** with `t3 auth device`
3. Client **polls** for the token

The client uses `POST /oauth/device_authorization`, then `POST /oauth/device_token`; the owner runs `t3 auth device list`, then `approve <user-code>`.
**Only the host CLI approves**; no HTTP route can.
Grants live in `auth_device_authorizations` through **`ForkSchema.ts`**.
The device code is **stored as a SHA-256 digest** and is single use.
A **DPoP start binds** the request and the session to that key.
Scopes are the **requested ones, else standard**; owner `--scope` only narrows.
**Browsers are refused**: CORS answers every origin, and no credential gates these routes.
`--ttl` sets the session lifetime; **renewal is a new grant**.
Revoke the **issued session** with `t3 auth session revoke`.
Open requests are **capped and expire**.

### External MCP clients

`approve --mcp-project <id>` or `--mcp-all-projects` grants an **MCP policy instead of scopes**.
The client calls `/api/mcp/external`, a **second MCP server** with its own `t3_external_*` catalog.

- **DPoP device session** only, with scopes `[]`
- Scope-checked **routes and RPCs refuse** it
- Each **socket RPC refuses** it
- Policy in **`auth_external_mcp_grants`**, per session

`/api/auth/websocket-ticket` needs only authentication, so the session can still open a socket.
Reads **cover granted projects**: projects, threads, timelines, and waits.
Reads add **`work`**: background work and native subagent turns that run status misses; `/mcp` reads include it too.
`until=work` **waits for that work** on both servers; a pinned `runId` wait keeps its run outcome.
**Mutations** are create, send, interrupt, settle/unsettle, and answer, behind `--mcp-coordinate` only.
Pending questions and approvals are addressed **by request ID**; **approvals stay owner-only**.
Grants carry **runtime and interaction mode ceilings**, defaulting to `approval-required` and `plan`.
`auth_external_mcp_requests` **binds each retry key** to its request and result.
A **lost result replays** the delivered message, pinned interrupt, or original settlement event.
A capped grant **joins or live-answers only an attempt it vetted**; message answers queue.
Dispatch **refuses a capped send**, create prompt, or message answer once its vetted attempt or thread modes changed.
Ceilings **hold at dispatch commit**; later owner mode changes govern later turns.
Failures return MCP **`isError: true`**, text led by the failure code; upstream's read-only refusal keeps its own text.
Provenance is **`createdBy: agent`**, `creationSource: mcp`, plus an audit log line.
The server is built in **one `Layer.fresh`**, so `/mcp` never lists these tools.

### Retirement condition

A tagged upstream release ships owner-approved native client authorization.
When a tag ships upstream's external MCP client audience (`pingdotgg/t3code#15220`), feed its authenticator from device grants and keep only the project and mode policy.

### Rebase scan

| Path                                                                                                                                              | Why it matters                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/server/src/auth/DeviceAuthorization.fork.ts`, `apps/server/src/cli/authDevice.fork.ts`                                                      | Fork-owned grant and CLI                                                    |
| `apps/server/src/server.ts`, `apps/server/src/cli/auth.ts`, `apps/server/src/persistence/ForkSchema.ts`                                           | Route, command, table hooks                                                 |
| `apps/server/src/auth/SessionStore.ts`, `apps/server/src/auth/dpop.ts`                                                                            | Reused issue and proof APIs                                                 |
| `apps/server/src/auth/ExternalMcpGrant.fork.ts`, `apps/server/src/mcp/external/`, `apps/server/src/mcp/toolkits/external/`                        | Fork-owned MCP policy, server, tools                                        |
| `apps/server/src/mcp/OrchestratorMcpService.ts`, `apps/server/src/mcp/McpHttpServer.ts`                                                           | Reused thread helpers and response normalizer                               |
| `packages/shared/src/orchestrationV2PendingBackgroundWork.ts`, `packages/contracts/src/orchestrationV2.ts`                                        | Background roster and native subagent test read by `work`                   |
| `apps/server/src/mcp/McpThreadWork.fork.ts`, `packages/contracts/src/mcpThreadWork.fork.ts`, `packages/contracts/src/orchestratorMcp.ts`          | Shared `work` view and `/mcp` contract hooks                                |
| `apps/server/src/mcp/toolkits/orchestrator/handlers.ts`, `apps/server/src/mcp/toolkits/orchestrator/threadWork.fork.ts`                           | `/mcp` thread read handler hook                                             |
| `apps/server/src/orchestration-v2/ThreadManagementService.ts`, `apps/server/src/orchestration-v2/steerTarget.fork.ts`                             | `steerTarget` send pin hooks                                                |
| `apps/server/src/orchestration-v2/Orchestrator.ts`, `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/externalMcpSend.fork.ts` | `steerAttemptId` and send/settlement/answer `expectedModes` dispatch checks |
| `apps/server/src/orchestration-v2/externalSettlement.fork.ts`, `packages/contracts/src/externalMcpSettlement.fork.ts`                             | Settlement commit guard and acknowledgement                                 |

## distribution

### Need

- Upstream **releases ship upstream code**
- A **fork build** and update feed
- The fork **lacks upstream's runners**

### Shape

```text
.github/workflows/
├── hyprws-ci.yml                     checks, tests, trailers, desktop build
├── hyprws-body.yml                   advisory citation and squash-trailer checks
├── hyprws-release.yml                stable and per-landing prerelease builds
├── hyprws-stable.yml                 cuts and dispatches each stable
└── hyprws-agent-context-budget.yml   upstream's budget check against the PR base
scripts/
├── fork-stable-cut.ts                stable commit and tag
├── fork-release-version.ts           channel metadata and previous tag
└── build-desktop-artifact.ts         update feed from GITHUB_REPOSITORY
apps/desktop/src/updates/
└── updateChannels.fork.ts            nightly tag to the hyprws-nightly channel
```

Stable tags are **`vX.Y.Z-hyprws.N`**; nightlies are **`vX.Y.Z-hyprws-nightly.YYYYMMDD.N`**.
A six-hourly **changed-head check** backs up the per-landing nightly.
`hyprws-release.yml` **omits** upstream's `concurrency.queue: max` and its **release test jobs**; its gate requires a green `hyprws CI` push run on the release commit.
Upstream workflows stay in the tree **untouched and disabled**; [Fork sync](../operations/fork-sync.md) owns the disable step.

### Retirement condition

Retired with the fork, or when upstream publishes builds the fork can ship unchanged.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                | Why it matters                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/desktop/src/updates/updateChannels.fork.ts`                                                                                                                                                                                                                                                                                                                                                                   | Fork-only; a conflict means upstream took the path |
| `packages/shared/src/forkVersion.ts`, `apps/web/src/versionSkew.fork.ts`, `apps/web/src/versionSkew.fork.test.ts`, `packages/shared/src/cliRelease.fork.test.ts`, `packages/ssh/src/tunnel.fork.test.ts`, `scripts/install.fork.test.ts`, `apps/server/src/cloud/servicePreflight.fork.ts`, `docs/fork/user/install-and-update.md`                                                                                  | Fork-only; a conflict means upstream took the path |
| `apps/web/src/versionSkew.ts`, `apps/server/src/cloud/servicePreflight.ts`, `apps/server/src/cli/install.ts`, `packages/shared/src/cliRelease.ts`, `packages/shared/src/cliRelease.test.ts`, `packages/ssh/src/tunnel.ts`, `packages/ssh/src/tunnel.test.ts`                                                                                                                                                        | Shared server and orchestration seams              |
| `apps/desktop/src/updates/DesktopUpdates.fork.test.ts`, `apps/desktop/src/updates/DesktopUpdates.ts`, `apps/desktop/src/updates/updatesTestHarness.ts`                                                                                                                                                                                                                                                              | Shared desktop and Electron seams                  |
| `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/install.sh`, `scripts/resolve-nightly-release.ts`, `scripts/build-desktop-artifact.ts`, `scripts/build-desktop-artifact.test.ts`, `scripts/update-release-package-versions.ts`, `package.json`, `engines`, `packageManager`, `docs/fork/internals/scripts.md`, `README.md`, `docs/README.md`, `docs/user/install.md`, `docs/user/updating.md` | Shared tooling, workflows, and docs                |

## backend-attach

Retired: run a `t3 service` and turn the desktop's **Local environment** off.
The revert sits **on top of the domain's commits**; a fold drops them together.

## workspace-files

### Need

- Artifacts in **ignored or shared scratch**
- **Hidden by default**, revealed on demand

### Shape

A **client-local preference** includes gitignored paths on demand, exposed in the file-tree toolbar and General settings.
On mobile, `ignoredWorkspaceFileListing.ts` keeps device state and reveal/reset policy **behind one fork-owned boundary**, never inline in the surfaces.
Listing ignored paths **never changes ignore rules** or weakens file-read containment.

### Retirement condition

Upstream reveals ignored workspace paths on demand and safely reads explicitly trusted artifact links shared across worktrees.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Why it matters                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `packages/contracts/src/project.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/settings.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                   | Shared contracts and wire schemas                           |
| `apps/server/src/workspace/WorkspaceEntries.ts`, `apps/server/src/vcs/GitVcsDriver.ts`, `apps/server/src/workspace/WorkspaceFileSystem.ts`, `apps/server/src/server.ts`, `apps/server/src/workspace/WorkspaceEntries.test.ts`                                                                                                                                                                                                                                                                                                                          | Shared server and orchestration seams                       |
| `apps/web/src/components/files/FileBrowserPanel.tsx`, `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/files/projectFilesQueryState.ts`, `apps/web/src/components/settings/settingsSearch.ts`                                                                                                                                                                                                                                                                                                                           | Shared web surfaces                                         |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Shared desktop and Electron seams                           |
| `apps/web/src/components/files/useDirectoryEntries.ts`, `apps/mobile/src/features/files/useFileTreeEntries.ts`, `apps/mobile/vite.config.ts`                                                                                                                                                                                                                                                                                                                                                                                                           | Directory requests, visibility invalidation, and test setup |
| `apps/mobile/src/features/files/ignoredWorkspaceFileListing.ts`, `apps/mobile/src/features/files/ignoredWorkspaceFileListing.fork.test.ts`, `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx`, `apps/mobile/src/features/files/thread-file-navigator-pane.tsx`, `apps/mobile/src/features/files/FileTreeBrowser.tsx`, `apps/mobile/src/features/files/fileTree.ts`, `apps/mobile/src/features/files/fileTree.fork.test.ts`, `apps/mobile/src/features/settings/SettingsRouteScreen.tsx`, `apps/mobile/src/persistence/mobile-preferences.ts` | Shared mobile surfaces                                      |
| `README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Shared tooling, workflows, and docs                         |

## thread-ordering

### Need

- **Group** related active threads
- **Return** to automatic order
- Upstream's `activeOrderKey` **has no groups**

### Shape

Grouping uses **sortable-tree depth**; a group may have **one parent row**, which is visual only.
Each environment's `fork_thread_groups` table is **served by `ThreadGroupsServiceFork`**; clients follow `threadGroups.subscribeFork`.
**Collapsed state stays per client**; pre-server local groups import once per environment.
Server thread-title generation **names groups**; a one-member group **dissolves**.
Scope is **active, unpinned threads** of one environment, from any project.
Agents use **`t3_thread_group_list` and `t3_thread_group_update`**; launches join the caller's group unless `group` says otherwise.
Only servers **advertising `threadGroupsFork`** show groups; upstream clients never call the fork RPCs.

### Retirement condition

Upstream ships named, server-side thread groups that agents can read and edit, plus a control that returns active threads to automatic order.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Why it matters                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `packages/contracts/src/environmentHttp.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/environment.ts`, `packages/contracts/src/clientRpcPermissions.ts`, `packages/contracts/src/orchestratorMcp.ts`, `packages/contracts/src/index.ts`                                                                                                                                                                                                                         | Shared contracts and wire schemas           |
| `apps/server/src/orchestration-v2/ThreadGroupTitles.ts`, `apps/server/src/orchestration-v2/http.ts`, `apps/server/src/server.ts`, `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/environment/ServerEnvironment.ts`, `apps/server/src/observability/RpcInstrumentation.ts`, `apps/server/src/persistence/ForkSchema.ts`                                                                                                                                            | Shared server and orchestration seams       |
| `apps/server/src/mcp/McpHttpServer.ts`, `apps/server/src/mcp/OrchestratorMcpService.ts`, `apps/server/src/mcp/toolkits/orchestrator/handlers.ts`, `apps/server/src/mcp/toolkits/project/handlers.ts`, `apps/server/src/mcp/toolkits/project/tools.ts`                                                                                                                                                                                                                           | Group toolkit and launch `group` hooks      |
| `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/components/Sidebar.logic.test.ts`, `apps/web/src/components/Sidebar.logic.fork.test.ts`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/SidebarThreadGroup.tsx`, `apps/web/src/components/SidebarRenameInput.tsx`, `apps/web/src/state/threadGroups.ts`, `apps/web/src/uiStateStore.ts`, `apps/web/src/uiStateStore.test.ts`, `apps/web/src/connection/runtime.ts`, `apps/web/src/routes/__root.tsx` | Shared web surfaces                         |
| `packages/client-runtime/src/state/threadGroups.ts`, `packages/client-runtime/src/state/threadGroupTitleHttp.ts`, `packages/client-runtime/package.json`, `packages/client-runtime/src/rpc/client.ts`                                                                                                                                                                                                                                                                           | Shared packages                             |
| `apps/server/src/provider/AgentContextBudget.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                           | Registration of fork group-tool definitions |
| `docs/user/thread-sidebar.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Shared tooling, workflows, and docs         |

## thread-fork

### Need

- A thread **continues as a copy**
- Same **provider instance and native session**

### Shape

**Fork thread** in the sidebar and header menus dispatches V2 `thread.fork` from `latest_stable`, then navigates to the child.
Upstream forks **only from an assistant message**; the fork adds the thread-level entry.
`decideForkExecution` in `CommandPolicy.ts` **picks native or portable** fork.
It works for **any configured provider** with a finished run.
It is **disabled while busy**: running, waiting, or holding a pending request or queued turn.
The child is titled **`X (fork)`**; forking a fork does not stack the suffix.

### Retirement condition

A tagged upstream release ships a thread-level fork entry in the thread menu.

### Rebase scan

| Path                                                                                                                                                                             | Why it matters                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `apps/web/src/state/threadFork.fork.ts`, `apps/web/src/components/threadActionMenu.logic.fork.ts`, `apps/web/src/components/threadActionMenu.logic.ts`                           | Command and menu state                          |
| `apps/web/src/hooks/useThreadActionMenu.ts`, `apps/web/src/hooks/useThreadActionMenu.fork.ts`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/contextMenuFallback.fork.ts` | Shared web surfaces                             |
| `apps/server/src/orchestration-v2/CommandPolicy.ts`, `apps/server/src/orchestration-v2/Orchestrator.ts`                                                                          | Upstream fork policy and `latest_stable` source |

## upstream-fixes

### Need

- Fixes **belonging to no domain**
- At the **stack bottom**, each drops alone
- Upstream fixes it, **the commit goes**

### Shape

- **One upstream-native commit** per fix
- Tagged **`bugfix`**, `Fork-Upstreamable: yes`
- **Branched from `upstream/main`**, no fork deps
- **No helpers** shared across fixes

### Terminal focus contract

Three commits **share one behavior contract** while each still drops alone, so a rebase that drops one **re-checks the other two**:

- **Jump, previous/next, palette** keys leave a terminal
- Other keys **stay in the terminal**
- Thread navigation **lands in the composer**
- Terminal focus **only on explicit request**
- **Return and close** land in the composer
- The focused pane shows a **static ring**

Proof is `apps/web/src/components/ThreadTerminalDrawer.test.ts`, `ChatView.logic.test.ts`, and a **Chrome pass** on each landing.

### Retirement condition

Per commit: upstream ships the fix, and the next rebase drops the commit.
The domain retires when it is empty.

### Rebase scan

| Path                                  | Why it matters                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `native/libghostty-vt/VERSION`        | Moved: rebuild `ghostty-sprite.wasm`; Ghostty `76e568b` or later needs a `global.zig` stub and Zig 0.16                |
| `apps/server/src/cloud/selfUpdate.ts` | Launcher repoint runs after the handoff is accepted; retire once a client update repoints `install.sh`'s `t3` upstream |
| `apps/server/src/cli/update.ts`       | `repointLauncher` and its ownership rule are reused, not copied                                                        |
| `**`                                  | Other shared paths                                                                                                     |

## zmux-estate

### Need

- Terminal and worktree **in zmux**
- Upstream owns **no session manager**

### Shape

`terminalSessionMode` is the **default launch**; a terminal's `sessionModeFork` overrides it.
`zmuxAutoSessions` (null follows the launch mode) **gates worktree adoption** and unsettle restore.
The **physical checkout owns** its managed session; threads are consumers.
T3 **snapshots a session identity** and hands it back for conditional removal.
Settle or delete **kills the checkout session** and every tab; viewers and busy commands do not preserve it.
`thread.unsettled` **re-ensures** a linked worktree's session through the automatic gate.
Each plain-shell fallback **prints its reason**; a missing binary degrades silently.
Legacy `zmuxSessions` **folds into `terminalSessionMode`** on load.
The binder, `apps/server/src/zmux/`, runs **through `ProcessRunner`** with tmux variables stripped.

### Demand leases

**Visible terminal surfaces** hold demand: web on document visibility, Electron on each shown, non-minimized window, **never on focus**.
Electron **cannot see Hyprland workspace occlusion**, so a shown window on an inactive workspace still holds demand.
Client streams **release immediately**; a server-owned grace timer then detaches only the `zmux open` PTY.
Resume **re-resolves the persisted checkout**, so renames follow the verified target.

### Checkout moves

A thread moves between existing checkouts through a **durable requested and effective transition**, queued behind active turns and serialized by ordered checkout leases.
A move **relocates a provider only** when that thread has a live runtime; a dormant thread moves metadata and records a null effective checkout.
**Partial failures retain** provider availability and the observed effective checkout.
A turn start on a thread whose **worktree is gone** runs a recovery move to the project root inline, bypassing only that thread's own pending turn.
Terminal follow and pin **stay client-owned**; move state carries no attachment identities.
Move state **rides the V2 thread payload** through `thread.metadata.update`, so it needs no fork column.
`ForkSchema.ts` only **clears the stale migration record** a V1 build left behind.
Managed suspension **stays internal**; released clients decode it through the optional `attachmentStatus` sibling.

### Retirement condition

Upstream terminals attach to an operator-chosen external session manager, and worktree lifecycle exposes hooks it can bind to.

### Rebase scan

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Why it matters                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/server/src/terminal/ManagedAttachmentLifecycle.ts`, `apps/web/src/state/terminalAttachmentRetention.fork.ts`, `apps/server/src/zmux/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Fork-only; a conflict means upstream took the path |
| `packages/contracts/src/terminal.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/git.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/src/settings.test.ts`, `packages/contracts/src/orchestration.ts`, `packages/contracts/src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Shared contracts and wire schemas                  |
| `apps/server/src/terminal/Manager.ts`, `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/orchestration-v2/EventSink.ts`, `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionStore.ts`, `apps/server/src/orchestration-v2/runtimeLayer.ts`, `apps/server/src/orchestration-v2/ThreadLaunchService.ts`, `apps/server/src/server.ts`, `apps/server/src/ws.ts`, `apps/server/src/git/GitManager.ts`, `apps/server/src/git/GitManager.test.ts`, `apps/server/src/serverSettings.ts`, `apps/server/src/serverSettings.test.ts`, `apps/server/src/processRunner.ts`, `apps/server/src/git/CheckoutMutationCoordinator.ts`, `apps/server/src/project/AgentSessionImporter.test.ts`, `apps/server/src/persistence/ForkSchema.ts`, `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` | Shared server and orchestration seams              |
| `apps/web/src/components/ThreadTerminalDrawer.tsx`, `apps/web/src/components/onboarding/WelcomePage.tsx`, `apps/web/src/state/terminalSessions.ts`, `apps/web/src/state/terminalSessions.test.ts`, `apps/web/src/state/terminalAttachmentRetention.fork.test.ts`, `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/ThreadTerminalDrawer.test.ts`, `apps/web/src/components/settings/settingsSearch.ts`, `apps/web/src/state/entities.ts`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/BranchToolbarBranchSelector.tsx`, `apps/web/src/components/BranchToolbarBranchSelector.fork.ts`, `apps/web/src/components/BranchToolbar.logic.fork.ts`, `apps/web/src/terminal/ghostty/surface.ts`                                                                                                          | Shared web surfaces                                |
| `apps/desktop/src/window/DesktopWindow.ts`, `apps/desktop/src/preview/WindowPolicy.preload.ts`, `apps/desktop/src/ipc/channels.ts`, `apps/desktop/src/window/DesktopWindow.test.ts`, `apps/desktop/src/preload.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Shared desktop and Electron seams                  |
| `apps/mobile/src/features/terminal/ThreadTerminalRouteScreen.tsx`, `apps/mobile/src/persistence/mobile-preferences.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Shared mobile surfaces                             |
| `packages/client-runtime/src/state/terminal.ts`, `packages/client-runtime/src/state/runtime.test.ts`, `packages/client-runtime/src/operations/checkoutMove.fork.ts`, `packages/client-runtime/src/operations/commands.ts`, `packages/client-runtime/src/state/threadCommands.ts`, `packages/client-runtime/src/state/checkoutMove.ts`, `packages/client-runtime/package.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Shared packages                                    |
| `docs/architecture/terminal-renderers.md`, `docs/user/source-control.md`, `docs/internals/terminal-runtime.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Shared tooling, workflows, and docs                |

## worktrunk-hooks

### Need

- **Parity** with `wt switch --create`
- `.config/wt.toml` hooks on **create and remove**
- Upstream **calls Git directly**

### Shape

`ThreadEnvMode` **gains `worktrunk`**, labelled "New worktrunk"; upstream's `worktree` is untouched.
`worktrunk` **never crosses the wire**; an optional `defaultThreadEnvModeFork` sibling carries it.
Events, projection, and `t3.json` **keep the wide mode**; `settings.json` migrates on read.
The first turn **drops a `t3-worktrunk` marker** in the worktree gitdir; `git worktree remove` deletes it, so no thread or project state records the mode.
Local VCS status **reports `worktrunk: true`** while the marker exists, which the started thread's composer reads.
`pre-start` and `post-start` run **before the setup script**; `post-remove` runs in the primary checkout.
Hooks run **headless** through `wt hook <type> --yes`; a failed create hook lands as error activity.
The mode **needs `.config/wt.toml` and `wt` on PATH**; without either it degrades to `worktree`.
Pull-request threads and mobile are **unsupported**; mobile maps a `worktrunk` default to a worktree.
Worktree **paths stay T3 Code's**; the fork never delegates to `wt switch` or `wt remove`.
The runner, `apps/server/src/worktrunk/`, runs **through `ProcessRunner`** with tmux variables stripped.
It has **no column**; a future one uses the idempotent `ForkSchema.ts` pattern.

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

## delegated-rounds

### Need

- **One delegated child** across rounds
- Rounds: **brief, findings, reply, ruling**
- The child **keeps its own context**

### Shape

`delegate_task` with **`continueTaskId`** continues a task; the wire carries it as an optional field on `delegated_task.request`.
Reopening keeps the **same `taskId`** on the current parent run, with delivery reset to pending.
Each child run yields **one `subagent_result`** while the task runs.
Each round **opens on the current parent run's cohort**.
`task_status` reads **the current round's** transfer; upstream `task_cancel` interrupts the active round.
**Archiving the child releases** it; unarchiving retains it again.
It **refuses** a busy task or child, a released child, and a foreign task.
Policy is **one instruction bullet**; tool descriptions stay upstream.
Later rounds **leave the original timeline node** and turn item as round 1 left them.
A round whose child run ends before it starts **still counts as that round's result**.

### Retirement condition

Upstream delivers a follow-up to a finished delegated child as its own result: status, parent wake, and cancel (`pingdotgg/t3code#15004`, `pingdotgg/t3code#13490`).
Retention and release stay fork scope until upstream keeps one task across rounds.

### Rebase scan

| Path                                                                                                                                                           | Why it matters                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/server/src/orchestration-v2/delegatedRounds.fork.ts`, `apps/server/src/provider/T3OrchestrationInstructions.fork.ts`                                     | Fork-only; a conflict means upstream took the path |
| `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/mcp/OrchestratorMcpService.ts`, `apps/server/src/provider/T3OrchestrationInstructions.ts` | Shared server and orchestration seams              |
| `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/orchestratorMcp.ts`                                                                       | Shared contracts and wire schemas                  |

## voice-input

### Need

- **Remote transcription** via OpenAI-compatible APIs
- **Live preview** over OpenAI Realtime
- **Speaker ducking** while recording on desktop

### Shape

The remote service is **one more model** on upstream `SpeechService`: `RemoteSpeechModel.fork.ts` wraps the layer, so every client selects and uses it through upstream's voice endpoints.
Selection is upstream's **`speechModelId`** setting, holding **`fork/remote`**: stock servers read an unknown id as their default model, so this fork value is deliberate; base URL, model, and key stay in the **`fork-voice-input` secret**, behind one fork HTTP route.
Batch posts the **multipart transcription**; live relays the **PCM stream over Realtime**.
Upstream **custom words** go out as the `prompt`, then upstream aliases and filler removal run on the result.
Ducking **hooks upstream's PCM capture**; the desktop bridge restores speakers even when a recording is cancelled before ducking starts.
**Mobile stays upstream-owned**, and the remote model still works from it.
The remote model **needs a host upstream's local speech supports**: clients gate voice on `capabilities.voiceTranscription`, set from the host platform.

### Retirement condition

Upstream voice input supports a configurable OpenAI-compatible transcription service.
Ducking stays fork scope until upstream lowers speaker volume while recording.

### Rebase scan

| Path                                                      | Why it matters             |
| --------------------------------------------------------- | -------------------------- |
| `apps/server/src/speech/SpeechService.ts`                 | Wrapped service shape      |
| `apps/server/src/server.ts`                               | Layer wrap and route mount |
| `apps/web/src/speech/browserPcmCapture.ts`                | Ducking start and stop     |
| `apps/web/src/components/settings/VoiceSettingsPanel.tsx` | Fork settings sections     |
| `packages/contracts/src/index.ts`                         | Fork contract export       |
| `packages/client-runtime/src/rpc/index.ts`                | Settings HTTP export       |
| `packages/contracts/src/ipc.ts`                           | Speaker bridge contract    |
| `apps/desktop/src/main.ts`                                | Desktop ducking lifetime   |
| `apps/desktop/src/app/DesktopApp.ts`                      | Await speaker restoration  |
| `apps/desktop/src/preload.ts`                             | Speaker control bridge     |
| `apps/desktop/src/ipc/DesktopIpcHandlers.ts`              | Speaker control handlers   |

## colleague-collab

### Need

- **Share one thread** with a collaborator's app
- **Own server** via a pairing link, no T3 Connect
- Shares and stops **reach their sidebar live**
- The agent sees **who wrote each message**
- Per share, **the host can approve** each message

### Shape

Code says **collaborator**; the subject prefix, tables, and this domain id **keep `colleague`**.
A pairing link for subject **`colleague:<slug>`** carries only the orchestration read and operate scopes.
`fork_colleague_shares` holds **one row per subject and thread**, with its `access`.
`CollaboratorSharesFork.wrapHandlers` **narrows dispatch**, shell, and thread subscriptions in `ws.ts`.
Shell items carry **`collaboratorFork`**: `send`, `approve`, or `frozen`.
`approve` **refuses dispatch**; messages wait in `fork_collaborator_messages` until the host sends.
`send` dispatches **conversation commands only**; managing the thread stays the host's.
**Only the server sets** `context.collaboratorFork`; the agent text names the collaborator.
Unsharing **re-snapshots the shell**, drops waiting messages, and pauses an open thread stream.
Collaborator subjects are **refused the unfiltered HTTP** shell snapshot.
`guardRpc` **allows a closed RPC set**; thread reads and asset URLs only for live shares.
Behind a loopback proxy, `cf-connecting-ip` or `x-forwarded-for` is **recorded as the address**.
The thread id **rides the pairing URL query**, which pairing ignores; the desktop opens it once paired.

### Retirement condition

A tagged upstream release shares a single thread with another person's client and attributes their messages.

### Rebase scan

| Path                                                                                                                                                                                                                                                                      | Why it matters                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `apps/server/src/ws.ts`                                                                                                                                                                                                                                                   | Handler wrapper and RPC guard                       |
| `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/observability/RpcInstrumentation.ts`, `packages/contracts/src/clientRpcPermissions.ts`                                                                                                                       | Scopes and spans for the share RPCs                 |
| `apps/server/src/orchestration-v2/http.ts`                                                                                                                                                                                                                                | HTTP shell and thread guards                        |
| `apps/server/src/auth/utils.ts`                                                                                                                                                                                                                                           | Forwarded client address                            |
| `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/composerContext.ts`, `packages/client-runtime/src/state/models.ts`, `packages/client-runtime/src/userMessage.ts`                                                                                     | Shell access and message author                     |
| `packages/contracts/src/environment.ts`, `apps/server/src/environment/ServerEnvironment.ts`, `packages/client-runtime/src/rpc/client.ts`                                                                                                                                  | Capability and message stream                       |
| `apps/web/src/components/ChatView.tsx`                                                                                                                                                                                                                                    | Composer overrides and waiting messages             |
| `apps/server/src/server.ts`, `apps/server/src/persistence/ForkSchema.ts`                                                                                                                                                                                                  | Layer and tables                                    |
| `packages/contracts/src/rpc.ts`, `packages/contracts/src/index.ts`                                                                                                                                                                                                        | RPC group and export                                |
| `apps/web/src/components/desktop/DesktopWebLinkCoordinator.tsx`                                                                                                                                                                                                           | Collaborator link branch: prompt, pair, open thread |
| `apps/web/src/routes/pair.tsx`                                                                                                                                                                                                                                            | Browser landing: open in app or continue            |
| `apps/web/src/components/PermissionUpdateNotice.ts`                                                                                                                                                                                                                       | No re-pair nag for a collaborator grant             |
| `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/threadActionMenu.logic.ts`, `apps/web/src/hooks/useThreadActionMenu.ts`                                                                                                                                   | Thread menu entry; host-only row controls hidden    |
| `apps/web/src/components/chat/ThreadDetailsPanel.tsx`, `apps/web/src/components/chat/threadDetailsItems.ts`                                                                                                                                                               | Collaborators section and its show toggle           |
| `apps/web/src/routes/__root.tsx`                                                                                                                                                                                                                                          | Dialog host and message notices                     |
| `apps/server/src/wsRpcHandlers.fork.ts`, `apps/server/src/wsRpcHandlers.fork-test-harness.ts`, `packages/contracts/src/rpc.fork.ts`, `apps/web/src/components/threadActionMenu.logic.fork.ts`                                                                             | Fork files shared with other domains                |
| `apps/server/src/collaborator/**`, `apps/server/src/auth/forwardedAddress.fork.ts`, `apps/web/src/components/collaborator/**`, `packages/contracts/src/collaborator.fork.ts`, `packages/client-runtime/src/userMessage.fork.ts`, `docs/fork/user/collaborator-sharing.md` | Fork-only; a conflict means upstream took the path  |

## Adding a domain

A new domain needs a section with the **same four headings**, a **domain index row**, and a **`FORK_DOMAINS` entry** to carry as `Fork-Domain`.
Answer:

1. What does **upstream not do**, as behavior?
2. What would upstream **ship to delete it**?
3. Which **upstream paths** does it touch?

If the third answer is "many files across unrelated systems", it is **probably a bugfix** under `upstream-fixes`.
Keep its new code **in its own files**, and follow [Extracting a domain](./fork-development.md#extracting-a-domain).
