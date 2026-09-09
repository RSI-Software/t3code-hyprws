# Fork test divergence — upstream test files touched in place

Measured with:

```sh
git diff --numstat v0.0.41-nightly.20260909.1426 origin/hyprws -- '*.test.ts' '*.test.tsx' \
  | grep -v '\.fork\.test\.'
```

against tag `v0.0.41-nightly.20260909.1426`. The command returns **146 files**: 56 are upstream test files the fork edits in place; the other 90 are fork-authored test files created without the `*.fork.test.*` suffix, which therefore also match the grep. Totals: +32,462 / −198.

Counts are taken at `hyprws` commit `b20eb5e34f`. Each file's class is durable, but a later fork
commit that touches a listed file moves that row's line count and the totals with it; rerun the
command above before quoting a number.

Classes: `append` (fork only added; upstream assertions untouched), `rewrite` (an upstream assertion's meaning changed), `deletion` (an upstream assertion or case removed). New fork-authored files carry no upstream assertions, so they are classed `append` with kind _new-file_.

## Summary

| Class                                                         | Files |
| ------------------------------------------------------------- | ----: |
| append (upstream files edited in place)                       |    37 |
| append (new fork-authored files, missing `.fork.test` suffix) |    90 |
| rewrite                                                       |    18 |
| deletion                                                      |     1 |

## Upstream test files edited in place (56)

| File                                                                   | Diff       | Class    |
| ---------------------------------------------------------------------- | ---------- | -------- |
| `apps/desktop/src/app/DesktopClerk.test.ts`                            | +7 / −3    | rewrite  |
| `apps/desktop/src/app/DesktopLifecycle.test.ts`                        | +10 / −0   | append   |
| `apps/desktop/src/backend/DesktopBackendPool.test.ts`                  | +4 / −0    | append   |
| `apps/desktop/src/ipc/methods/preview.test.ts`                         | +42 / −13  | append   |
| `apps/desktop/src/preview/Manager.test.ts`                             | +87 / −16  | rewrite  |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`              | +3 / −0    | append   |
| `apps/desktop/src/ssh/DesktopSshPasswordPrompts.test.ts`               | +5 / −0    | append   |
| `apps/desktop/src/updates/DesktopUpdates.test.ts`                      | +4 / −4    | rewrite  |
| `apps/desktop/src/window/DesktopApplicationMenu.test.ts`               | +4 / −0    | append   |
| `apps/desktop/src/window/DesktopWindow.test.ts`                        | +602 / −20 | append   |
| `apps/mobile/src/features/terminal/terminalMenu.test.ts`               | +9 / −1    | append   |
| `apps/server/src/checkpointing/CheckpointDiffQuery.test.ts`            | +5 / −0    | append   |
| `apps/server/src/environment/ServerEnvironment.test.ts`                | +1 / −0    | append   |
| `apps/server/src/git/GitManager.test.ts`                               | +25 / −1   | append   |
| `apps/server/src/git/GitWorkflowService.test.ts`                       | +20 / −0   | append   |
| `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`       | +54 / −36  | rewrite  |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts`     | +1 / −0    | append   |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`      | +7 / −0    | append   |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` | +2 / −0    | append   |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`  | +91 / −9   | append   |
| `apps/server/src/orchestration/decider.projectThreadEnvMode.test.ts`   | +1 / −0    | append   |
| `apps/server/src/project/AgentSessionImporter.test.ts`                 | +4 / −0    | append   |
| `apps/server/src/project/AgentSessionScanner.test.ts`                  | +1 / −0    | append   |
| `apps/server/src/project/ProjectSetupScriptRunner.test.ts`             | +3 / −2    | rewrite  |
| `apps/server/src/project/RepositoryIdentityResolver.test.ts`           | +14 / −15  | rewrite  |
| `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts`      | +2 / −1    | rewrite  |
| `apps/server/src/provider/Layers/CodexAdapter.test.ts`                 | +8 / −2    | rewrite  |
| `apps/server/src/provider/Layers/CodexCollabWire.test.ts`              | +10 / −7   | rewrite  |
| `apps/server/src/provider/Layers/ProviderService.test.ts`              | +1 / −0    | append   |
| `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`        | +1 / −0    | append   |
| `apps/server/src/provider/ProviderInstanceEnvironment.test.ts`         | +23 / −5   | rewrite  |
| `apps/server/src/provider/acp/CursorAcpSupport.test.ts`                | +5 / −0    | append   |
| `apps/server/src/provider/acp/GrokAcpSupport.test.ts`                  | +1 / −0    | append   |
| `apps/server/src/pullRequest/PullRequestService.test.ts`               | +20 / −7   | rewrite  |
| `apps/server/src/server.test.ts`                                       | +630 / −13 | append   |
| `apps/server/src/serverRuntimeStartup.test.ts`                         | +4 / −0    | append   |
| `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts`    | +30 / −3   | rewrite  |
| `apps/server/src/workspace/WorkspaceEntries.test.ts`                   | +7 / −1    | append   |
| `apps/server/src/workspace/WorkspaceFileSystem.test.ts`                | +5 / −0    | append   |
| `apps/web/src/components/ChatMarkdown.test.tsx`                        | +3 / −3    | rewrite  |
| `apps/web/src/components/RightPanelTabs.test.tsx`                      | +6 / −2    | append   |
| `apps/web/src/components/Sidebar.logic.test.ts`                        | +4 / −3    | append   |
| `apps/web/src/components/chat/composerProviderState.test.tsx`          | +5 / −4    | rewrite  |
| `apps/web/src/components/preview/PreviewEmptyState.test.tsx`           | +3 / −0    | append   |
| `apps/web/src/components/preview/PreviewView.test.tsx`                 | +3 / −1    | append   |
| `apps/web/src/components/settings/KeybindingsSettings.logic.test.ts`   | +4 / −0    | append   |
| `apps/web/src/components/settings/settingsSearch.test.ts`              | +8 / −1    | rewrite  |
| `apps/web/src/hooks/useHandleNewThread.test.ts`                        | +11 / −0   | append   |
| `apps/web/src/keybindings.test.ts`                                     | +7 / −2    | rewrite  |
| `apps/web/src/localApi.test.ts`                                        | +0 / −5    | deletion |
| `apps/web/src/rightPanelStore.test.ts`                                 | +16 / −8   | rewrite  |
| `apps/web/src/terminalUiStateStore.test.ts`                            | +2 / −0    | append   |
| `apps/web/src/uiStateStore.test.ts`                                    | +7 / −0    | append   |
| `packages/client-runtime/src/state/threadReducer.test.ts`              | +12 / −6   | rewrite  |
| `packages/contracts/src/settings.test.ts`                              | +4 / −4    | append   |
| `scripts/build-desktop-artifact.test.ts`                               | +3 / −0    | append   |

## `rewrite` rows — assertion affected and owning commit

- `apps/desktop/src/app/DesktopClerk.test.ts` (+7 / −3) — `cfd9465bd5f`: `assert.deepEqual(registeredEvents, ["second-instance"])` weakened to `assert.include`; `clerk.configure` → `clerk.configure(() => Effect.void)`.
- `apps/desktop/src/preview/Manager.test.ts` (+87 / −16) — `f5839c6d0ff`: Three upstream expectations rewritten: guest `zoom-changed` events are now adopted instead of ignored; `reapplyZoom` → `preserveGuestZooms` with embedder-before-guest ordering; window-close race error `PreviewMainWindowClosedError` → `PreviewTabNotFoundError`.
- `apps/desktop/src/updates/DesktopUpdates.test.ts` (+4 / −4) — `38dd3f2c626`: All `installSteps` assertions gained a leading `"capture"` step.
- `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts` (+54 / −36) — `85a40bb55be`: “does not adopt a drifted checkout from %s when the worktree is shared by another thread” inverted to “adopts a drifted checkout … for idle threads sharing the worktree” (expected branch stays `threadBranch` + no PR refresh → both threads follow the renamed ref).
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts` (+3 / −2) — `43c71f57602`: Expected terminal write payloads `"npm install\r"` / `"bun install\r"` → wrapped with `&& echo '[t3] setup script completed' || echo '[t3] setup script FAILED'\r`.
- `apps/server/src/project/RepositoryIdentityResolver.test.ts` (+14 / −15) — `118436798ca`: Expected `locator.remoteName` `upstream` → `origin`; refresh now keeps `julius/t3code` on `add` instead of adopting `t3tools/t3code` (`canonicalKey`/`displayName` expectations rewritten).
- `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts` (+2 / −1) — `5ec7743785d`: SDK fixture `agents: []` → a `fable` agent; expected probe result gains an `agents` field.
- `apps/server/src/provider/Layers/CodexAdapter.test.ts` (+8 / −2) — `9b8512d68fb`: Upstream `deepStrictEqual` of the whole runtime-factory start-options object → split into `environment` checks (`T3CODE_THREAD_ID` set, `T3CODE_PROJECT_ID` unset) plus a partial `deepStrictEqual` of the remainder.
- `apps/server/src/provider/Layers/CodexCollabWire.test.ts` (+10 / −7) — `9736354e8ce`: “drops only enumerated child chatter” asserted `item/agentMessage/delta`, `item/reasoning/textDelta`, and `item/commandExecution/outputDelta` are dropped; the fork moved them into the forwarded passthrough list.
- `apps/server/src/provider/ProviderInstanceEnvironment.test.ts` (+23 / −5) — `6937937a6b0`: “leaves inherited provider homes unchanged” now expects only the own driver's home (`CODEX_HOME` _or_ `CLAUDE_CONFIG_DIR`), not both; the override case went from `toMatchObject` to strict `toEqual` with `TMUX`/`TMUX_PANE` pinning.
- `apps/server/src/pullRequest/PullRequestService.test.ts` (+20 / −7) — `cfd9465bd5f`: Upstream case “refuses a repository that does not belong to the requested project” inverted in place to “reads a repository …” (expected `PullRequestOperationError` → expects success).
- `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts` (+30 / −3) — `118436798ca`: Expected gh `pr create` argv gains `--repo github.com/rsi-software/t3code-hyprws`; `createInput` expectation gains `repository`; `getChangeRequest`/`createPullRequest` calls now pass a `context` argument.
- `apps/web/src/components/ChatMarkdown.test.tsx` (+3 / −3) — `b5868db8aec`: GitHub-icon favicon input changed from `https://github.com/pingdotgg/t3code/pull/1` to bare `https://github.com`.
- `apps/web/src/components/chat/composerProviderState.test.tsx` (+5 / −4) — `5ec7743785d`: Three plan-mode tests switched provider `codex` → `opencode` in both input and expected state.
- `apps/web/src/components/settings/settingsSearch.test.ts` (+8 / −1) — `97d07d3beda`: `searchSettings("external links")[0]` equals `browser-link-target` → relaxed to `.find(id === "browser-link-target")` anywhere in the results; a new external-workspace-symlinks assertion was inserted into an upstream case.
- `apps/web/src/keybindings.test.ts` (+7 / −2) — `5995bebfd61`: “never shows jump hints while the terminal is focused” inverted to “shows jump hints … because the drawer forwards them” (`assert.isFalse` → `assert.isTrue`).
- `apps/web/src/rightPanelStore.test.ts` (+16 / −8) — `9dc747be4b9`: “replaces the standalone explorer with peer file surfaces” inverted to “keeps the standalone explorer beside peer file surfaces” (expected `surfaces` no longer drop `files`); agents-surface expectations reshaped to the extended `agentsSurface` object.
- `packages/client-runtime/src/state/threadReducer.test.ts` (+12 / −6) — `eb9298b51ee`: Live-append ordering expectation changed from `[activity-a, activity-b, activity-null]` to `[activity-null, activity-a, activity-b, activity-c]`; the “snapshot loads freeze the null-sequence prefix” premise was replaced (snapshot prefix is repaired, not frozen).

## `deletion` rows

- `apps/web/src/localApi.test.ts` (+0 / −5) — `3f9e734d640` (removed the upstream `showContextMenu` delegation assertions — the `showContextMenu` bridge mock, the `items` fixture, `api.contextMenu.show(items)` resolving `"delete"`, and `expect(showContextMenu).toHaveBeenCalledWith(items, undefined)`. The follow-up additive-gate repair walk `cfd9465bd5f` reported `findings: 0` and did not restore them (tracked by RSI-Software/t3code-hyprws#697)).

## Fork-authored test files missing the `*.fork.test` suffix (90, kind new-file)

None of these has an upstream counterpart, so nothing upstream was rewritten or deleted in them. Renaming them into `*.fork.test.*` siblings is delta-shrink work under RSI-Software/t3code-hyprws#665 and out of scope here.

| File                                                                      | Diff       | Class             |
| ------------------------------------------------------------------------- | ---------- | ----------------- |
| `apps/desktop/src/window/DesktopLaunchIntent.test.ts`                     | +97 / −0   | append (new-file) |
| `apps/desktop/src/window/DesktopWindowSession.test.ts`                    | +167 / −0  | append (new-file) |
| `apps/desktop/src/window/hyprland.test.ts`                                | +179 / −0  | append (new-file) |
| `apps/server/src/git/CheckoutMutationCoordinator.test.ts`                 | +40 / −0   | append (new-file) |
| `apps/server/src/githubIssue/GitHubIssueService.test.ts`                  | +428 / −0  | append (new-file) |
| `apps/server/src/githubIssue/gitHubIssueJson.test.ts`                     | +171 / −0  | append (new-file) |
| `apps/server/src/orchestration/AgentActivityProjection.test.ts`           | +230 / −0  | append (new-file) |
| `apps/server/src/orchestration/Layers/AgentActivitySnapshotQuery.test.ts` | +146 / −0  | append (new-file) |
| `apps/server/src/orchestration/ThreadGroupTitles.test.ts`                 | +38 / −0   | append (new-file) |
| `apps/server/src/orchestration/agentActivityCursor.test.ts`               | +37 / −0   | append (new-file) |
| `apps/server/src/provider/Drivers/CodexAgents.test.ts`                    | +72 / −0   | append (new-file) |
| `apps/server/src/provider/childItemRenderDetail.test.ts`                  | +109 / −0  | append (new-file) |
| `apps/server/src/provider/providerSessionEnvironment.test.ts`             | +42 / −0   | append (new-file) |
| `apps/server/src/terminal/ManagedAttachmentLifecycle.test.ts`             | +133 / −0  | append (new-file) |
| `apps/server/src/worktrunk/WorktrunkHookRunner.test.ts`                   | +312 / −0  | append (new-file) |
| `apps/server/src/zmux/ZmuxSessionBinder.test.ts`                          | +366 / −0  | append (new-file) |
| `apps/web/src/browserBookmarkStore.test.ts`                               | +152 / −0  | append (new-file) |
| `apps/web/src/components/AgentDetailPanel.logic.test.ts`                  | +130 / −0  | append (new-file) |
| `apps/web/src/components/AgentDetailPanel.test.tsx`                       | +594 / −0  | append (new-file) |
| `apps/web/src/components/AgentsPanel.logic.test.ts`                       | +61 / −0   | append (new-file) |
| `apps/web/src/components/AgentsPanel.test.tsx`                            | +199 / −0  | append (new-file) |
| `apps/web/src/components/SidebarRenameInput.test.tsx`                     | +70 / −0   | append (new-file) |
| `apps/web/src/components/WindowProjectScopeToggle.test.tsx`               | +83 / −0   | append (new-file) |
| `apps/web/src/components/chat/AgentPicker.test.ts`                        | +25 / −0   | append (new-file) |
| `apps/web/src/components/chat/AgentSpawnCta.logic.test.ts`                | +45 / −0   | append (new-file) |
| `apps/web/src/components/chat/githubLinkDestinations.test.ts`             | +54 / −0   | append (new-file) |
| `apps/web/src/components/files/markdownPipeline.test.ts`                  | +93 / −0   | append (new-file) |
| `apps/web/src/components/githubIssue/GitHubIssueDetailPanel.test.tsx`     | +109 / −0  | append (new-file) |
| `apps/web/src/components/githubIssue/GitHubIssueList.logic.test.ts`       | +33 / −0   | append (new-file) |
| `apps/web/src/components/githubIssue/GitHubIssueListView.logic.test.ts`   | +156 / −0  | append (new-file) |
| `apps/web/src/components/githubIssue/githubIssueChips.logic.test.ts`      | +79 / −0   | append (new-file) |
| `apps/web/src/components/githubIssue/githubIssueRouteSearch.test.ts`      | +50 / −0   | append (new-file) |
| `apps/web/src/components/preview/PreviewBookmarkMenu.test.tsx`            | +55 / −0   | append (new-file) |
| `apps/web/src/components/pullRequest/PullRequestMarkdownEditor.test.ts`   | +35 / −0   | append (new-file) |
| `apps/web/src/desktopProjectWindows.test.ts`                              | +74 / −0   | append (new-file) |
| `apps/web/src/lib/pullRequestAttachmentUpload.test.ts`                    | +203 / −0  | append (new-file) |
| `apps/web/src/lib/t3ProjectFileDefaults.test.ts`                          | +55 / −0   | append (new-file) |
| `apps/web/src/lucideOptimizer.test.ts`                                    | +138 / −0  | append (new-file) |
| `apps/web/src/projectRoutes.test.ts`                                      | +94 / −0   | append (new-file) |
| `apps/web/src/routes/-issuesPage.test.tsx`                                | +254 / −0  | append (new-file) |
| `apps/web/src/routes/-projectIndexRoute.test.tsx`                         | +135 / −0  | append (new-file) |
| `apps/web/src/routes/-projectRouteLayout.test.tsx`                        | +16 / −0   | append (new-file) |
| `apps/web/src/state/githubIssues.test.ts`                                 | +19 / −0   | append (new-file) |
| `apps/web/src/windowProjectScope.test.ts`                                 | +126 / −0  | append (new-file) |
| `packages/client-runtime/src/state/agentActivityHttp.test.ts`             | +166 / −0  | append (new-file) |
| `packages/client-runtime/src/state/githubIssues.test.ts`                  | +72 / −0   | append (new-file) |
| `packages/client-runtime/src/state/subagentDetail.test.ts`                | +307 / −0  | append (new-file) |
| `packages/client-runtime/src/state/threadGroupTitleHttp.test.ts`          | +55 / −0   | append (new-file) |
| `packages/contracts/src/githubIssue.test.ts`                              | +88 / −0   | append (new-file) |
| `scripts/dev-desktop-agent.test.ts`                                       | +454 / −0  | append (new-file) |
| `scripts/fork-auto-rebase.test.ts`                                        | +1169 / −0 | append (new-file) |
| `scripts/fork-carry.test.ts`                                              | +23 / −0   | append (new-file) |
| `scripts/fork-churn-outcomes.test.ts`                                     | +486 / −0  | append (new-file) |
| `scripts/fork-churn-seams.test.ts`                                        | +991 / −0  | append (new-file) |
| `scripts/fork-churn.test.ts`                                              | +1193 / −0 | append (new-file) |
| `scripts/fork-delta.test.ts`                                              | +1457 / −0 | append (new-file) |
| `scripts/fork-lesson-guidance.test.ts`                                    | +815 / −0  | append (new-file) |
| `scripts/fork-lockfile.test.ts`                                           | +171 / −0  | append (new-file) |
| `scripts/fork-orient.test.ts`                                             | +309 / −0  | append (new-file) |
| `scripts/fork-preflight.test.ts`                                          | +214 / −0  | append (new-file) |
| `scripts/fork-rebase-notify.test.ts`                                      | +608 / −0  | append (new-file) |
| `scripts/fork-rebase-report-artifact.test.ts`                             | +88 / −0   | append (new-file) |
| `scripts/fork-rebase-report.test.ts`                                      | +571 / −0  | append (new-file) |
| `scripts/fork-release-delta-rev.test.ts`                                  | +54 / −0   | append (new-file) |
| `scripts/fork-release-version.test.ts`                                    | +114 / −0  | append (new-file) |
| `scripts/fork-rewrite-archive.test.ts`                                    | +84 / −0   | append (new-file) |
| `scripts/fork-rewrite-build.test.ts`                                      | +1167 / −0 | append (new-file) |
| `scripts/fork-scan-authoring.test.ts`                                     | +614 / −0  | append (new-file) |
| `scripts/fork-scan-guards.test.ts`                                        | +1102 / −0 | append (new-file) |
| `scripts/fork-scan.test.ts`                                               | +459 / −0  | append (new-file) |
| `scripts/fork-stable-crossing.test.ts`                                    | +234 / −0  | append (new-file) |
| `scripts/fork-sync-gate.test.ts`                                          | +313 / −0  | append (new-file) |
| `scripts/fork-sync-outcomes.test.ts`                                      | +465 / −0  | append (new-file) |
| `scripts/fork-sync-stable.test.ts`                                        | +559 / −0  | append (new-file) |
| `scripts/fork-sync.test.ts`                                               | +6338 / −0 | append (new-file) |
| `scripts/fork-uat.test.ts`                                                | +553 / −0  | append (new-file) |
| `scripts/fork-upstream-refs.test.ts`                                      | +399 / −0  | append (new-file) |
| `scripts/fork-upstream-watch.test.ts`                                     | +470 / −0  | append (new-file) |
| `scripts/fork-workflow-drift.test.ts`                                     | +449 / −0  | append (new-file) |
| `scripts/hyprland-workspace.test.ts`                                      | +143 / −0  | append (new-file) |
| `scripts/lib/fork-additive.test.ts`                                       | +478 / −0  | append (new-file) |
| `scripts/lib/fork-bot-refs.test.ts`                                       | +372 / −0  | append (new-file) |
| `scripts/lib/fork-conflict-outcomes.test.ts`                              | +265 / −0  | append (new-file) |
| `scripts/lib/fork-foundation.test.ts`                                     | +71 / −0   | append (new-file) |
| `scripts/lib/fork-overlap.test.ts`                                        | +47 / −0   | append (new-file) |
| `scripts/lib/fork-policy.test.ts`                                         | +56 / −0   | append (new-file) |
| `scripts/lib/fork-repairs.test.ts`                                        | +276 / −0  | append (new-file) |
| `scripts/lib/fork-walk-size.test.ts`                                      | +94 / −0   | append (new-file) |
| `scripts/lib/fork-wire-shapes.test.ts`                                    | +194 / −0  | append (new-file) |
| `scripts/setup-worktree.test.ts`                                          | +300 / −0  | append (new-file) |
