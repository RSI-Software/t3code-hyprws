# Fork test divergence

> Upstream test files the fork touches in place.

Regenerate the sweep against the current base tag:

```sh
git diff --numstat <tag> origin/hyprws -- '*.test.ts' '*.test.tsx' | grep -v '\.fork\.test\.'
```

Two populations match: upstream files the fork edits in place, and fork-authored files still missing the `*.fork.test.*` suffix.
[Fork development](./fork-development.md#fork-tests-live-in-fork-owned-files) owns the suffix rule.

Line counts move with every commit, so quote no diff number from here.

## Upstream test files edited in place (56)

Machine-read.
`fork:scan` and the additive gate refuse a commit that changes or removes a line in an upstream test file, and exempt exactly this table's first column, parsed at the scanned head.
A file leaves the baseline by leaving this table, in the same commit that migrates it to a `*.fork.test.*` sibling.
Every other path list below is prose and grants nothing; an absent or unparseable table grants nothing either.
Keep the heading count equal to the row count: `scripts/lib/fork-test-debt.test.ts` asserts it.

A row absent from the two sections below only appended assertions.

| File                                                                   |
| ---------------------------------------------------------------------- |
| `apps/desktop/src/app/DesktopClerk.test.ts`                            |
| `apps/desktop/src/app/DesktopLifecycle.test.ts`                        |
| `apps/desktop/src/backend/DesktopBackendPool.test.ts`                  |
| `apps/desktop/src/ipc/methods/preview.test.ts`                         |
| `apps/desktop/src/preview/Manager.test.ts`                             |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`              |
| `apps/desktop/src/ssh/DesktopSshPasswordPrompts.test.ts`               |
| `apps/desktop/src/updates/DesktopUpdates.test.ts`                      |
| `apps/desktop/src/window/DesktopApplicationMenu.test.ts`               |
| `apps/desktop/src/window/DesktopWindow.test.ts`                        |
| `apps/mobile/src/features/terminal/terminalMenu.test.ts`               |
| `apps/server/src/checkpointing/CheckpointDiffQuery.test.ts`            |
| `apps/server/src/environment/ServerEnvironment.test.ts`                |
| `apps/server/src/git/GitManager.test.ts`                               |
| `apps/server/src/git/GitWorkflowService.test.ts`                       |
| `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`       |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts`     |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`      |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`  |
| `apps/server/src/orchestration/decider.projectThreadEnvMode.test.ts`   |
| `apps/server/src/project/AgentSessionImporter.test.ts`                 |
| `apps/server/src/project/AgentSessionScanner.test.ts`                  |
| `apps/server/src/project/ProjectSetupScriptRunner.test.ts`             |
| `apps/server/src/project/RepositoryIdentityResolver.test.ts`           |
| `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts`      |
| `apps/server/src/provider/Layers/CodexAdapter.test.ts`                 |
| `apps/server/src/provider/Layers/CodexCollabWire.test.ts`              |
| `apps/server/src/provider/Layers/ProviderService.test.ts`              |
| `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`        |
| `apps/server/src/provider/ProviderInstanceEnvironment.test.ts`         |
| `apps/server/src/provider/acp/CursorAcpSupport.test.ts`                |
| `apps/server/src/provider/acp/GrokAcpSupport.test.ts`                  |
| `apps/server/src/pullRequest/PullRequestService.test.ts`               |
| `apps/server/src/server.test.ts`                                       |
| `apps/server/src/serverRuntimeStartup.test.ts`                         |
| `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts`    |
| `apps/server/src/workspace/WorkspaceEntries.test.ts`                   |
| `apps/server/src/workspace/WorkspaceFileSystem.test.ts`                |
| `apps/web/src/components/ChatMarkdown.test.tsx`                        |
| `apps/web/src/components/RightPanelTabs.test.tsx`                      |
| `apps/web/src/components/Sidebar.logic.test.ts`                        |
| `apps/web/src/components/chat/composerProviderState.test.tsx`          |
| `apps/web/src/components/preview/PreviewEmptyState.test.tsx`           |
| `apps/web/src/components/preview/PreviewView.test.tsx`                 |
| `apps/web/src/components/settings/KeybindingsSettings.logic.test.ts`   |
| `apps/web/src/components/settings/settingsSearch.test.ts`              |
| `apps/web/src/hooks/useHandleNewThread.test.ts`                        |
| `apps/web/src/keybindings.test.ts`                                     |
| `apps/web/src/localApi.test.ts`                                        |
| `apps/web/src/rightPanelStore.test.ts`                                 |
| `apps/web/src/terminalUiStateStore.test.ts`                            |
| `apps/web/src/uiStateStore.test.ts`                                    |
| `packages/client-runtime/src/state/threadReducer.test.ts`              |
| `packages/contracts/src/settings.test.ts`                              |
| `scripts/build-desktop-artifact.test.ts`                               |

## Rewritten upstream assertions

Every `rewrite` row, with the upstream expectation the fork inverted and the commit that owns it.

| File                                                                | Upstream assertion changed                                                                                                        | Commit        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `apps/desktop/src/app/DesktopClerk.test.ts`                         | registered-events `deepEqual` weakened to `include`; `clerk.configure` takes an effect                                            | `cfd9465bd5f` |
| `apps/desktop/src/preview/Manager.test.ts`                          | guest `zoom-changed` adopted, not ignored; `reapplyZoom` became `preserveGuestZooms`; close race throws `PreviewTabNotFoundError` | `f5839c6d0ff` |
| `apps/desktop/src/updates/DesktopUpdates.test.ts`                   | every `installSteps` gained a leading `"capture"`                                                                                 | `38dd3f2c626` |
| `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`    | shared-worktree drift inverted to adopt for idle threads; branch stays `threadBranch`, no PR refresh                              | `85a40bb55be` |
| `apps/server/src/project/ProjectSetupScriptRunner.test.ts`          | install payloads wrapped with the completed/FAILED echo                                                                           | `43c71f57602` |
| `apps/server/src/project/RepositoryIdentityResolver.test.ts`        | `locator.remoteName` moved to `origin`; refresh keeps `julius/t3code` on add                                                      | `118436798ca` |
| `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts`   | SDK fixture gained a `fable` agent; probe result gained `agents`                                                                  | `5ec7743785d` |
| `apps/server/src/provider/Layers/CodexAdapter.test.ts`              | whole-object `deepStrictEqual` split into environment checks plus a partial compare                                               | `9b8512d68fb` |
| `apps/server/src/provider/Layers/CodexCollabWire.test.ts`           | three delta events moved from dropped to forwarded                                                                                | `9736354e8ce` |
| `apps/server/src/provider/ProviderInstanceEnvironment.test.ts`      | inherited homes expect the own driver only; override case strict and pins `TMUX`                                                  | `6937937a6b0` |
| `apps/server/src/pullRequest/PullRequestService.test.ts`            | foreign-repository refusal inverted to a read; error became success                                                               | `cfd9465bd5f` |
| `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts` | `pr create` argv gained `--repo`; calls gained `context`                                                                          | `118436798ca` |
| `apps/web/src/components/ChatMarkdown.test.tsx`                     | GitHub favicon input reduced to a bare host                                                                                       | `b5868db8aec` |
| `apps/web/src/components/chat/composerProviderState.test.tsx`       | three plan-mode tests moved provider `codex` to `opencode`                                                                        | `5ec7743785d` |
| `apps/web/src/components/settings/settingsSearch.test.ts`           | first-hit assertion relaxed to find-anywhere; a symlink assertion inserted                                                        | `97d07d3beda` |
| `apps/web/src/keybindings.test.ts`                                  | terminal-focus jump hints inverted to shown                                                                                       | `5995bebfd61` |
| `apps/web/src/rightPanelStore.test.ts`                              | explorer kept beside peer surfaces; agents surface extended                                                                       | `9dc747be4b9` |
| `packages/client-runtime/src/state/threadReducer.test.ts`           | live-append order changed; the snapshot prefix is repaired, not frozen                                                            | `eb9298b51ee` |

## Removed upstream assertions

`apps/web/src/localApi.test.ts` (`3f9e734d640`) dropped the upstream `showContextMenu` delegation case: the bridge mock, the `items` fixture, and both expectations.
The later additive repair walk found nothing to restore, tracked by RSI-Software/t3code-hyprws#697.

## Fork-authored files missing the `*.fork.test` suffix

None has an upstream counterpart, so nothing upstream was rewritten in them.
Renaming them into `*.fork.test.*` siblings is delta-shrink work under RSI-Software/t3code-hyprws#665.

```text
apps/desktop/src/window/DesktopLaunchIntent.test.ts
apps/desktop/src/window/DesktopWindowSession.test.ts
apps/desktop/src/window/hyprland.test.ts
apps/server/src/git/CheckoutMutationCoordinator.test.ts
apps/server/src/githubIssue/GitHubIssueService.test.ts
apps/server/src/githubIssue/gitHubIssueJson.test.ts
apps/server/src/orchestration/AgentActivityProjection.test.ts
apps/server/src/orchestration/Layers/AgentActivitySnapshotQuery.test.ts
apps/server/src/orchestration/ThreadGroupTitles.test.ts
apps/server/src/orchestration/agentActivityCursor.test.ts
apps/server/src/provider/Drivers/CodexAgents.test.ts
apps/server/src/provider/childItemRenderDetail.test.ts
apps/server/src/provider/providerSessionEnvironment.test.ts
apps/server/src/terminal/ManagedAttachmentLifecycle.test.ts
apps/server/src/worktrunk/WorktrunkHookRunner.test.ts
apps/server/src/zmux/ZmuxSessionBinder.test.ts
apps/web/src/browserBookmarkStore.test.ts
apps/web/src/components/AgentDetailPanel.logic.test.ts
apps/web/src/components/AgentDetailPanel.test.tsx
apps/web/src/components/AgentsPanel.logic.test.ts
apps/web/src/components/AgentsPanel.test.tsx
apps/web/src/components/SidebarRenameInput.test.tsx
apps/web/src/components/WindowProjectScopeToggle.test.tsx
apps/web/src/components/chat/AgentPicker.test.ts
apps/web/src/components/chat/AgentSpawnCta.logic.test.ts
apps/web/src/components/chat/githubLinkDestinations.test.ts
apps/web/src/components/files/markdownPipeline.test.ts
apps/web/src/components/githubIssue/GitHubIssueDetailPanel.test.tsx
apps/web/src/components/githubIssue/GitHubIssueList.logic.test.ts
apps/web/src/components/githubIssue/GitHubIssueListView.logic.test.ts
apps/web/src/components/githubIssue/githubIssueChips.logic.test.ts
apps/web/src/components/githubIssue/githubIssueRouteSearch.test.ts
apps/web/src/components/preview/PreviewBookmarkMenu.test.tsx
apps/web/src/components/pullRequest/PullRequestMarkdownEditor.test.ts
apps/web/src/desktopProjectWindows.test.ts
apps/web/src/lib/pullRequestAttachmentUpload.test.ts
apps/web/src/lib/t3ProjectFileDefaults.test.ts
apps/web/src/lucideOptimizer.test.ts
apps/web/src/projectRoutes.test.ts
apps/web/src/routes/-issuesPage.test.tsx
apps/web/src/routes/-projectIndexRoute.test.tsx
apps/web/src/routes/-projectRouteLayout.test.tsx
apps/web/src/state/githubIssues.test.ts
apps/web/src/windowProjectScope.test.ts
packages/client-runtime/src/state/agentActivityHttp.test.ts
packages/client-runtime/src/state/githubIssues.test.ts
packages/client-runtime/src/state/subagentDetail.test.ts
packages/client-runtime/src/state/threadGroupTitleHttp.test.ts
packages/contracts/src/githubIssue.test.ts
scripts/dev-desktop-agent.test.ts
scripts/fork-auto-rebase.test.ts
scripts/fork-carry.test.ts
scripts/fork-churn-outcomes.test.ts
scripts/fork-churn-seams.test.ts
scripts/fork-churn.test.ts
scripts/fork-delta.test.ts
scripts/fork-lesson-guidance.test.ts
scripts/fork-lockfile.test.ts
scripts/fork-orient.test.ts
scripts/fork-preflight.test.ts
scripts/fork-rebase-notify.test.ts
scripts/fork-rebase-report-artifact.test.ts
scripts/fork-rebase-report.test.ts
scripts/fork-release-delta-rev.test.ts
scripts/fork-release-version.test.ts
scripts/fork-rewrite-archive.test.ts
scripts/fork-rewrite-build.test.ts
scripts/fork-scan-authoring.test.ts
scripts/fork-scan-guards.test.ts
scripts/fork-scan.test.ts
scripts/fork-stable-crossing.test.ts
scripts/fork-sync-gate.test.ts
scripts/fork-sync-outcomes.test.ts
scripts/fork-sync-stable.test.ts
scripts/fork-sync.test.ts
scripts/fork-uat.test.ts
scripts/fork-upstream-refs.test.ts
scripts/fork-upstream-watch.test.ts
scripts/fork-workflow-drift.test.ts
scripts/hyprland-workspace.test.ts
scripts/lib/fork-additive.test.ts
scripts/lib/fork-bot-refs.test.ts
scripts/lib/fork-conflict-outcomes.test.ts
scripts/lib/fork-foundation.test.ts
scripts/lib/fork-overlap.test.ts
scripts/lib/fork-policy.test.ts
scripts/lib/fork-repairs.test.ts
scripts/lib/fork-walk-size.test.ts
scripts/lib/fork-wire-shapes.test.ts
scripts/setup-worktree.test.ts
```
