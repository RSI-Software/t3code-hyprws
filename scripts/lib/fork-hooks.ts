// The fork-hook manifest. An upstream file may carry hook lines only: fork code
// woven elsewhere is a woven seam and `fork-hook-seam` warns on it. Each hook
// is marked in source so a tool can find it, and listed here so a marker without
// a manifest entry — a hook the sync walk cannot reason about — is visible.
//
// Three marker forms:
//
// - a trailing `// fork-hook: <domain>/<name>` on a one-line hook (an import,
//   a call, a `const`, a property/spread);
// - `{/* fork-hook: <domain>/<name> */}` … `{/* fork-hook-end *` + `/}`
//   (the end-marker JSX comment) around a multi-line JSX construct;
// - a trailing `/* fork-hook: <domain>/<name> */` for one-line hooks in
//   languages where `//` is not a comment (CSS).
//
// The manifest starts empty: the sweep issues fill it as each recurring commit
// is reshaped into marked hooks. A hook is exactly one construct and never
// removes or modifies an upstream line. Anchor notes: `collection <symbol>`
// also covers a member of a type/interface/props/object named `symbol` (object
// properties and store members included), and `after-decl <symbol>` marks a
// hook placed immediately after the declaration of `symbol` — an export, const,
// or function that must sit next to a named upstream declaration.

import { FORK_DOMAINS } from "./fork-trailers.ts";

/** Where the hook sits in the upstream file, as the sync walk re-applies it. */
export type ForkHookAnchor =
  | { readonly kind: "import-block" }
  | { readonly kind: "collection"; readonly symbol: string }
  | { readonly kind: "jsx-parent"; readonly symbol: string }
  | { readonly kind: "after-call"; readonly symbol: string }
  | { readonly kind: "after-decl"; readonly symbol: string };

export interface ForkHookEntry {
  /** The upstream-owned file the hook lives in. */
  readonly path: string;
  readonly anchor: ForkHookAnchor;
}

/**
 * Keyed `<domain>/<name>`. Empty until the sweep lands the first marked hook;
 * the schema test passes on an empty manifest and tightens as entries arrive.
 */
export const FORK_HOOKS: Readonly<Record<string, ForkHookEntry>> = {
  // custom-agents — marked on RSI-Software/t3code-hyprws#963; test seams marked on #674 PR 2.
  "custom-agents/codex-test-env-split": {
    path: "apps/server/src/provider/Layers/CodexAdapter.test.ts",
    anchor: { kind: "after-call", symbol: "startSession" },
  },
  "custom-agents/codex-test-env-thread-id": {
    path: "apps/server/src/provider/Layers/CodexAdapter.test.ts",
    anchor: { kind: "after-call", symbol: "startSession" },
  },
  "custom-agents/codex-test-env-project-id": {
    path: "apps/server/src/provider/Layers/CodexAdapter.test.ts",
    anchor: { kind: "after-call", symbol: "startSession" },
  },
  "custom-agents/codex-test-start-options": {
    path: "apps/server/src/provider/Layers/CodexAdapter.test.ts",
    anchor: { kind: "after-call", symbol: "startSession" },
  },
  // custom-agents — marked on RSI-Software/t3code-hyprws#674 PR 2.
  "custom-agents/codex-session-identity-import": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "import-block" },
  },
  "custom-agents/codex-session-agent-import": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "import-block" },
  },
  "custom-agents/codex-driver-instance-env": {
    path: "apps/server/src/provider/Drivers/CodexDriver.ts",
    anchor: { kind: "after-decl", symbol: "pathService" },
  },
  "custom-agents/codex-child-item-lifecycle-import": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "import-block" },
  },
  "custom-agents/codex-collab-child-item": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "after-decl", symbol: "itemTypeRaw" },
  },
  "custom-agents/codex-collab-workspace-root": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "after-decl", symbol: "workspaceRoot" },
  },
  "custom-agents/codex-session-agent-resolve": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "after-call", symbol: "stopSessionInternal" },
  },
  "custom-agents/codex-session-identity-env": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "after-call", symbol: "readMcpProviderSession" },
  },
  "custom-agents/codex-session-agent-runtime-input": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "after-decl", symbol: "forkSessionEnvironment" },
  },
  "custom-agents/codex-session-identity-env-prop": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "collection", symbol: "CodexSessionRuntimeOptions" },
  },
  "custom-agents/codex-session-agent-option": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "collection", symbol: "CodexSessionRuntimeOptions" },
  },
  "custom-agents/codex-session-identity-mcp-env": {
    path: "apps/server/src/provider/Layers/CodexAdapter.ts",
    anchor: { kind: "collection", symbol: "CodexSessionRuntimeOptions" },
  },
  "custom-agents/claude-child-snapshot-import": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "import-block" },
  },
  "custom-agents/claude-child-snapshot-emit": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "after-decl", symbol: "handleAssistantMessage" },
  },
  "custom-agents/claude-child-snapshot-assistant": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "after-call", symbol: "rememberPendingTaskModel" },
  },
  "custom-agents/claude-child-snapshot-task-started": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "after-call", symbol: "offerRuntimeEvent" },
  },
  "custom-agents/claude-child-detail-denied": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "after-decl", symbol: "completedStamp" },
  },
  "custom-agents/ingestion-child-lifecycle-import": {
    path: "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts",
    anchor: { kind: "import-block" },
  },
  "custom-agents/ingestion-child-lifecycle-guard": {
    path: "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts",
    anchor: { kind: "after-decl", symbol: "isPersistableItemLifecycle" },
  },
  "custom-agents/ingestion-child-lifecycle-detail": {
    path: "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts",
    anchor: { kind: "collection", symbol: "payload" },
  },
  "custom-agents/ingestion-timeline-bypass": {
    path: "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts",
    anchor: { kind: "collection", symbol: "payload" },
  },
  "custom-agents/ingestion-provider-linkage": {
    path: "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts",
    anchor: { kind: "after-decl", symbol: "taskLinkageActivityFields" },
  },
  "custom-agents/claude-child-detail-import": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "import-block" },
  },
  "custom-agents/claude-agent-launch-args-import": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "import-block" },
  },
  "custom-agents/claude-child-detail-updated": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "after-call", symbol: "inFlightTools.set" },
  },
  "custom-agents/claude-child-detail-started": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "after-call", symbol: "inFlightTools.set" },
  },
  "custom-agents/claude-child-detail-completed": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "after-decl", symbol: "toolUseResult" },
  },
  "custom-agents/claude-launch-args": {
    path: "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    anchor: { kind: "after-call", symbol: "getModelSelectionStringOptionValue" },
  },
  "custom-agents/claude-agent-info-type": {
    path: "apps/server/src/provider/Layers/ClaudeProvider.ts",
    anchor: { kind: "collection", symbol: "ClaudeCapabilitiesProbe" },
  },
  "custom-agents/claude-agent-options-import": {
    path: "apps/server/src/provider/Layers/ClaudeProvider.ts",
    anchor: { kind: "import-block" },
  },
  "custom-agents/claude-probe-agents-field": {
    path: "apps/server/src/provider/Layers/ClaudeProvider.ts",
    anchor: { kind: "collection", symbol: "ClaudeCapabilitiesProbe" },
  },
  "custom-agents/claude-probe-agents-parse": {
    path: "apps/server/src/provider/Layers/ClaudeProvider.ts",
    anchor: { kind: "collection", symbol: "probeClaudeCapabilities" },
  },
  "custom-agents/claude-model-agent-options": {
    path: "apps/server/src/provider/Layers/ClaudeProvider.ts",
    anchor: { kind: "after-decl", symbol: "capabilities" },
  },
  "custom-agents/claude-dedupe-export": {
    path: "apps/server/src/provider/Layers/ClaudeProvider.ts",
    anchor: { kind: "after-decl", symbol: "probeClaudeCapabilities" },
  },
  "custom-agents/codex-agent-options-import": {
    path: "apps/server/src/provider/Drivers/CodexDriver.ts",
    anchor: { kind: "import-block" },
  },
  "custom-agents/codex-agent-options-decorator": {
    path: "apps/server/src/provider/Drivers/CodexDriver.ts",
    anchor: { kind: "after-call", symbol: "makeCodexAdapter" },
  },
  "custom-agents/spawn-navigation-import": {
    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
    anchor: { kind: "import-block" },
  },
  "custom-agents/spawn-open-handler": {
    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
    anchor: { kind: "after-decl", symbol: "onToggleSpawnRow" },
  },
  "custom-agents/compact-menu-agent-prop": {
    path: "apps/web/src/components/chat/CompactComposerControlsMenu.tsx",
    anchor: { kind: "collection", symbol: "CompactComposerControlsMenu" },
  },
  "custom-agents/compact-menu-agent-render": {
    path: "apps/web/src/components/chat/CompactComposerControlsMenu.tsx",
    anchor: { kind: "jsx-parent", symbol: "MenuPopup" },
  },
  "custom-agents/composer-state-agent-menu-content": {
    path: "apps/web/src/components/chat/composerProviderState.tsx",
    anchor: { kind: "after-decl", symbol: "renderProviderTraitsPicker" },
  },
  "custom-agents/composer-state-agent-picker": {
    path: "apps/web/src/components/chat/composerProviderState.tsx",
    anchor: { kind: "after-decl", symbol: "renderProviderTraitsPicker" },
  },
  "custom-agents/traits-persistence-export": {
    path: "apps/web/src/components/chat/TraitsPicker.tsx",
    anchor: { kind: "after-decl", symbol: "TraitsPersistence" },
  },
  "custom-agents/traits-default-badge-export": {
    path: "apps/web/src/components/chat/TraitsPicker.tsx",
    anchor: { kind: "after-decl", symbol: "DefaultBadge" },
  },
  "custom-agents/traits-replace-descriptor-export": {
    path: "apps/web/src/components/chat/TraitsPicker.tsx",
    anchor: { kind: "after-decl", symbol: "replaceDescriptorCurrentValue" },
  },
  "custom-agents/composer-agent-render-import": {
    path: "apps/web/src/components/chat/ChatComposer.tsx",
    anchor: { kind: "import-block" },
  },
  "custom-agents/composer-agent-menu-content": {
    path: "apps/web/src/components/chat/ChatComposer.tsx",
    anchor: { kind: "after-decl", symbol: "providerTraitsPickerInput" },
  },
  "custom-agents/composer-agent-picker": {
    path: "apps/web/src/components/chat/ChatComposer.tsx",
    anchor: { kind: "after-decl", symbol: "providerTraitsPickerInput" },
  },
  "custom-agents/composer-agent-resting-block-import": {
    path: "apps/web/src/components/chat/ChatComposer.tsx",
    anchor: { kind: "import-block" },
  },
  "custom-agents/composer-agent-resting-block": {
    path: "apps/web/src/components/chat/ChatComposer.tsx",
    anchor: { kind: "collection", symbol: "restingBlockDefs" },
  },
  "custom-agents/composer-agent-menu-prop": {
    path: "apps/web/src/components/chat/ChatComposer.tsx",
    anchor: { kind: "jsx-parent", symbol: "CompactComposerControlsMenu" },
  },
  "custom-agents/composer-agent-compact-menu-prop": {
    path: "apps/web/src/components/chat/ChatComposer.tsx",
    anchor: { kind: "jsx-parent", symbol: "CompactComposerControlsMenu" },
  },
  "custom-agents/right-panel-open-agents-decl": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "collection", symbol: "RightPanelStoreState" },
  },
  "custom-agents/right-panel-open-agents-import": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "import-block" },
  },
  "custom-agents/right-panel-open-agents": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "collection", symbol: "useRightPanelStore" },
  },
  "project-windows/index-fork-css": {
    path: "apps/web/src/index.css",
    anchor: { kind: "import-block" },
  },
  // upstream-fixes — external workspace symlinks marked on RSI-Software/t3code-hyprws#951.
  "upstream-fixes/wfs-fork-import": {
    path: "apps/server/src/workspace/WorkspaceFileSystem.ts",
    anchor: { kind: "import-block" },
  },
  "upstream-fixes/wfs-external-symlinks-policy": {
    path: "apps/server/src/workspace/WorkspaceFileSystem.ts",
    anchor: { kind: "after-decl", symbol: "workspaceEntries" },
  },
  "upstream-fixes/wfs-external-symlinks-follow": {
    path: "apps/server/src/workspace/WorkspaceFileSystem.ts",
    anchor: { kind: "after-decl", symbol: "relativeRealPath" },
  },
  "upstream-fixes/wfs-server-settings-layer": {
    path: "apps/server/src/server.ts",
    anchor: { kind: "collection", symbol: "WorkspaceFileSystemLayerLive" },
  },
  "upstream-fixes/settings-row-import": {
    path: "apps/web/src/components/settings/SettingsPanels.tsx",
    anchor: { kind: "import-block" },
  },
  "upstream-fixes/settings-restore-symlinks-label": {
    path: "apps/web/src/components/settings/SettingsPanels.tsx",
    anchor: { kind: "after-decl", symbol: "useSettingsRestore" },
  },
  "upstream-fixes/settings-row-mount": {
    path: "apps/web/src/components/settings/SettingsPanels.tsx",
    anchor: { kind: "jsx-parent", symbol: "GeneralSettingsPanel" },
  },
  "upstream-fixes/settings-search-external-symlinks-import": {
    path: "apps/web/src/components/settings/settingsSearch.ts",
    anchor: { kind: "import-block" },
  },
  "upstream-fixes/settings-search-external-symlinks": {
    path: "apps/web/src/components/settings/settingsSearch.ts",
    anchor: { kind: "collection", symbol: "SETTINGS_SEARCH_ITEMS" },
  },
  "upstream-fixes/settings-patch-field": {
    path: "packages/contracts/src/settings.ts",
    anchor: { kind: "collection", symbol: "ServerSettingsPatch" },
  },

  // workspace-files — ignored workspace files reshaped behind one listing hook on RSI-Software/t3code-hyprws#955.
  "workspace-files/file-browser-ignored-listing": {
    path: "apps/web/src/components/files/FileBrowserPanel.tsx",
    anchor: { kind: "import-block" },
  },
  "workspace-files/file-browser-ignored-listing-call": {
    path: "apps/web/src/components/files/FileBrowserPanel.tsx",
    anchor: { kind: "after-call", symbol: "useComposerHandleContext" },
  },
  "workspace-files/file-browser-ignored-git-status": {
    path: "apps/web/src/components/files/FileBrowserPanel.tsx",
    anchor: { kind: "after-call", symbol: "buildFileTreePathUpdates" },
  },
  "workspace-files/file-browser-ignored-toggle": {
    path: "apps/web/src/components/files/FileBrowserPanel.tsx",
    anchor: { kind: "jsx-parent", symbol: "FileBrowserPanel" },
  },
  "workspace-files/project-list-entries-input": {
    path: "packages/contracts/src/project.ts",
    anchor: { kind: "collection", symbol: "ProjectListEntriesInput" },
  },
  "workspace-files/workspace-entries-ignored-listing-import": {
    path: "apps/server/src/workspace/WorkspaceEntries.ts",
    anchor: { kind: "import-block" },
  },
  "workspace-files/workspace-entries-ignored-registry-import": {
    path: "apps/server/src/workspace/WorkspaceEntries.ts",
    anchor: { kind: "import-block" },
  },
  "workspace-files/workspace-entries-ignored-registry": {
    path: "apps/server/src/workspace/WorkspaceEntries.ts",
    anchor: { kind: "after-decl", symbol: "workspaceSearchIndexes" },
  },
  "workspace-files/workspace-entries-list-ignored": {
    path: "apps/server/src/workspace/WorkspaceEntries.ts",
    anchor: { kind: "after-call", symbol: "workspaceSearchIndexes.get" },
  },
  "workspace-files/git-driver-ignored-import": {
    path: "apps/server/src/vcs/GitVcsDriver.ts",
    anchor: { kind: "import-block" },
  },
  "workspace-files/git-driver-ignored-listing": {
    path: "apps/server/src/vcs/GitVcsDriver.ts",
    anchor: { kind: "after-decl", symbol: "listWorkspaceFiles" },
  },
  "workspace-files/vcs-driver-ignored-member": {
    path: "apps/server/src/vcs/VcsDriver.ts",
    anchor: { kind: "collection", symbol: "Service" },
  },
  "workspace-files/server-workspace-entries-registry": {
    path: "apps/server/src/server.ts",
    anchor: { kind: "after-decl", symbol: "WorkspaceEntriesLayerLive" },
  },
  "workspace-files/workspace-entries-test-registry-import": {
    path: "apps/server/src/workspace/WorkspaceEntries.test.ts",
    anchor: { kind: "import-block" },
  },
  "workspace-files/workspace-entries-test-registry-layer": {
    path: "apps/server/src/workspace/WorkspaceEntries.test.ts",
    anchor: { kind: "collection", symbol: "TestLayer" },
  },
  "workspace-files/mobile-route-ignored-listing-import": {
    path: "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
    anchor: { kind: "import-block" },
  },
  "workspace-files/mobile-route-ignored-listing-call": {
    path: "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
    anchor: { kind: "after-decl", symbol: "revealedInspectorRef" },
  },
  "workspace-files/mobile-inspector-ignored-listing-import": {
    path: "apps/mobile/src/features/files/thread-file-navigator-pane.tsx",
    anchor: { kind: "import-block" },
  },
  "workspace-files/mobile-inspector-ignored-listing-call": {
    path: "apps/mobile/src/features/files/thread-file-navigator-pane.tsx",
    anchor: { kind: "after-decl", symbol: "headerScrollEdgeEffects" },
  },
  // project-windows — marked on RSI-Software/t3code-hyprws#952.
  "project-windows/pull-request-page-scope-import": {
    path: "apps/web/src/routes/_chat.pull-requests.tsx",
    anchor: { kind: "import-block" },
  },
  "project-windows/pull-request-page-scope": {
    path: "apps/web/src/routes/_chat.pull-requests.tsx",
    anchor: { kind: "after-decl", symbol: "capableEnvironments" },
  },
  "project-windows/pull-request-scope-search-field": {
    path: "apps/web/src/routes/_chat.pull-requests.tsx",
    anchor: { kind: "collection", symbol: "PullRequestsSearch" },
  },
  "project-windows/pull-request-scope-patch": {
    path: "apps/web/src/routes/_chat.pull-requests.tsx",
    anchor: { kind: "after-call", symbol: "updateSearch" },
  },
  "project-windows/pull-request-scope-toggle": {
    path: "apps/web/src/routes/_chat.pull-requests.tsx",
    anchor: { kind: "jsx-parent", symbol: "PullRequestsColumn" },
  },
  "project-windows/pull-request-filter-visibility": {
    path: "apps/web/src/components/pullRequest/PullRequestListFilters.tsx",
    anchor: { kind: "collection", symbol: "PullRequestFiltersMenu" },
  },
  "project-windows/sidebar-pr-list-route-import": {
    path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    anchor: { kind: "import-block" },
  },
  // worktrunk-hooks — marked on RSI-Software/t3code-hyprws#960.
  "worktrunk-hooks/env-mode-selector-import": {
    path: "apps/web/src/components/BranchToolbar.tsx",
    anchor: { kind: "import-block" },
  },
  "worktrunk-hooks/workspace-icon-import": {
    path: "apps/web/src/components/BranchToolbar.tsx",
    anchor: { kind: "import-block" },
  },
  "worktrunk-hooks/workspace-icon": {
    path: "apps/web/src/components/BranchToolbar.tsx",
    anchor: { kind: "collection", symbol: "WorkspaceIcon" },
  },
  "worktrunk-hooks/env-mode-menu-worktrunk": {
    path: "apps/web/src/components/BranchToolbar.tsx",
    anchor: { kind: "jsx-parent", symbol: "MenuRadioGroup" },
  },
  "worktrunk-hooks/env-mode-mobile-worktrunk-prop": {
    path: "apps/web/src/components/BranchToolbar.tsx",
    anchor: { kind: "jsx-parent", symbol: "MobileRunContextSelector" },
  },
  "worktrunk-hooks/env-mode-selector-worktrunk-prop": {
    path: "apps/web/src/components/BranchToolbar.tsx",
    anchor: { kind: "jsx-parent", symbol: "BranchToolbarEnvModeSelector" },
  },
  "worktrunk-hooks/env-mode-selector-cog-import": {
    path: "apps/web/src/components/BranchToolbarEnvModeSelector.tsx",
    anchor: { kind: "import-block" },
  },
  "worktrunk-hooks/env-mode-selector-worktrunk-item-import": {
    path: "apps/web/src/components/BranchToolbarEnvModeSelector.tsx",
    anchor: { kind: "import-block" },
  },
  "worktrunk-hooks/env-mode-selector-worktrunk-prop-type": {
    path: "apps/web/src/components/BranchToolbarEnvModeSelector.tsx",
    anchor: { kind: "collection", symbol: "BranchToolbarEnvModeSelectorProps" },
  },
  "worktrunk-hooks/env-mode-selector-worktrunk-default": {
    path: "apps/web/src/components/BranchToolbarEnvModeSelector.tsx",
    anchor: { kind: "collection", symbol: "BranchToolbarEnvModeSelector" },
  },
  "worktrunk-hooks/env-mode-selector-worktrunk-option": {
    path: "apps/web/src/components/BranchToolbarEnvModeSelector.tsx",
    anchor: { kind: "collection", symbol: "envModeItems" },
  },
  "worktrunk-hooks/env-mode-selector-locked-icon": {
    path: "apps/web/src/components/BranchToolbarEnvModeSelector.tsx",
    anchor: { kind: "jsx-parent", symbol: "BranchToolbarEnvModeSelector" },
  },
  "worktrunk-hooks/env-mode-selector-trigger-icon": {
    path: "apps/web/src/components/BranchToolbarEnvModeSelector.tsx",
    anchor: { kind: "jsx-parent", symbol: "SelectTrigger" },
  },
  "worktrunk-hooks/env-mode-selector-worktrunk-item": {
    path: "apps/web/src/components/BranchToolbarEnvModeSelector.tsx",
    anchor: { kind: "jsx-parent", symbol: "SelectGroup" },
  },
  "worktrunk-hooks/env-mode-enum-import": {
    path: "apps/web/src/components/BranchToolbar.logic.ts",
    anchor: { kind: "import-block" },
  },
  "worktrunk-hooks/env-mode-enum": {
    path: "apps/web/src/components/BranchToolbar.logic.ts",
    anchor: { kind: "collection", symbol: "EnvMode" },
  },
  "worktrunk-hooks/env-mode-label-import": {
    path: "apps/web/src/components/BranchToolbar.logic.ts",
    anchor: { kind: "import-block" },
  },
  "worktrunk-hooks/env-mode-label": {
    path: "apps/web/src/components/BranchToolbar.logic.ts",
    anchor: { kind: "after-decl", symbol: "resolveEnvModeLabel" },
  },
  "worktrunk-hooks/draft-thread-env-mode-schema-import": {
    path: "apps/web/src/composerDraftStore.ts",
    anchor: { kind: "import-block" },
  },
  "worktrunk-hooks/draft-thread-env-mode-schema": {
    path: "apps/web/src/composerDraftStore.ts",
    anchor: { kind: "after-decl", symbol: "DraftThreadEnvModeSchema" },
  },
  // github-issues — marked on RSI-Software/t3code-hyprws#954.
  "github-issues/chat-markdown-github-destination-import": {
    path: "apps/web/src/components/ChatMarkdown.tsx",
    anchor: { kind: "import-block" },
  },
  "github-issues/chat-markdown-github-destination": {
    path: "apps/web/src/components/ChatMarkdown.tsx",
    anchor: { kind: "after-decl", symbol: "openExternalLinkInPreview" },
  },
  "github-issues/chat-markdown-github-destination-state": {
    path: "apps/web/src/components/ChatMarkdown.tsx",
    anchor: { kind: "collection", symbol: "componentState" },
  },
  "github-issues/chat-markdown-github-destination-deps": {
    path: "apps/web/src/components/ChatMarkdown.tsx",
    anchor: { kind: "collection", symbol: "componentState" },
  },
  "github-issues/chat-markdown-github-destination-value": {
    path: "apps/web/src/components/ChatMarkdown.tsx",
    anchor: { kind: "collection", symbol: "ChatMarkdownRendererContext" },
  },
  "github-issues/chat-markdown-github-destination-return": {
    path: "apps/web/src/components/ChatMarkdown.tsx",
    anchor: { kind: "after-decl", symbol: "linkChildren" },
  },
  "github-issues/open-pull-request-link-fork-import": {
    path: "apps/web/src/lib/openPullRequestLink.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/issue-link-project": {
    path: "apps/web/src/lib/openPullRequestLink.ts",
    anchor: { kind: "after-decl", symbol: "preferredProjectId" },
  },
  "github-issues/issue-link-repository": {
    path: "apps/web/src/lib/openPullRequestLink.ts",
    anchor: { kind: "after-decl", symbol: "issueProject" },
  },
  "github-issues/change-request-preferred-project": {
    path: "apps/web/src/lib/openPullRequestLink.ts",
    anchor: { kind: "after-decl", symbol: "preferredProjectId" },
  },
  "github-issues/settings-open-mode-import": {
    path: "packages/contracts/src/settings.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/settings-link-open-mode-export": {
    path: "packages/contracts/src/settings.ts",
    anchor: { kind: "after-decl", symbol: "QuitConfirmationModeSetting" },
  },
  "github-issues/settings-change-request-open-mode-export": {
    path: "packages/contracts/src/settings.ts",
    anchor: { kind: "after-decl", symbol: "QuitConfirmationModeSetting" },
  },
  "github-issues/settings-link-open-mode-field": {
    path: "packages/contracts/src/settings.ts",
    anchor: { kind: "collection", symbol: "ClientSettingsSchema" },
  },
  "github-issues/settings-change-request-open-mode-field": {
    path: "packages/contracts/src/settings.ts",
    anchor: { kind: "collection", symbol: "ClientSettingsSchema" },
  },
  "github-issues/settings-link-open-mode-patch": {
    path: "packages/contracts/src/settings.ts",
    anchor: { kind: "collection", symbol: "ClientSettingsPatch" },
  },
  "github-issues/settings-change-request-open-mode-patch": {
    path: "packages/contracts/src/settings.ts",
    anchor: { kind: "collection", symbol: "ClientSettingsPatch" },
  },
};

export const forkHookKey = (domain: string, name: string): string => `${domain}/${name}`;

// The comment must close the line: a marker mid-comment marks nothing.
export const FORK_HOOK_LINE_MARKER = /^\/\/\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*$/;
export const FORK_HOOK_LINE_SUFFIX = /\s+\/\/\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*$/;
export const FORK_HOOK_BLOCK_SUFFIX = /\s+\/\*\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*\*\/\s*$/;
export const FORK_HOOK_JSX_OPEN = /\{\/\*\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*\*\/\}/;
export const FORK_HOOK_JSX_END = /\{\/\*\s*fork-hook-end\s*\*\/\}/;

/**
 * A single-construct re-export hook, recognised for the `after-decl` anchor: a
 * fork export placed immediately after an upstream declaration of the same
 * symbol (`export { X }; // fork-hook: <domain>/<name>`, `export type { T };`).
 */
export const HOOK_REEXPORT = /^\s*export\s+(type\s+)?\{\s*[\w$]+\s*\};?\s*$/;

export const stripForkHookLineMarker = (line: string): string =>
  line.replace(FORK_HOOK_LINE_SUFFIX, "");

/** A marker found in source: its key and the line span it marks (1-based, inclusive). */
export interface ParsedForkHook {
  readonly key: string;
  readonly domain: string;
  readonly name: string;
  /** `line`: the marker line is the whole hook. `jsx`: open marker to end marker. */
  readonly kind: "line" | "jsx";
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Every marker in one file's text, in source order. A line marker covers exactly
 * its own line; a JSX open marker covers through the next end marker (or end of
 * file when unclosed, so a missing end marker still bounds the
 * region rather than swallowing the rest of the file silently as "unmarked").
 */
export const parseForkHookMarkers = (content: string): ReadonlyArray<ParsedForkHook> => {
  const lines = content.split("\n");
  const hooks: Array<ParsedForkHook> = [];
  let open: { key: string; domain: string; name: string; startLine: number } | null = null;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (open !== null) {
      if (FORK_HOOK_JSX_END.test(line)) {
        hooks.push({ ...open, kind: "jsx", endLine: lineNumber });
        open = null;
      }
      continue;
    }
    const jsx = FORK_HOOK_JSX_OPEN.exec(line);
    if (jsx !== null) {
      open = {
        key: forkHookKey(jsx[1] ?? "", jsx[2] ?? ""),
        domain: jsx[1] ?? "",
        name: jsx[2] ?? "",
        startLine: lineNumber,
      };
      continue;
    }
    const line1 = FORK_HOOK_LINE_SUFFIX.exec(line) ?? FORK_HOOK_BLOCK_SUFFIX.exec(line);
    if (line1 !== null) {
      hooks.push({
        key: forkHookKey(line1[1] ?? "", line1[2] ?? ""),
        domain: line1[1] ?? "",
        name: line1[2] ?? "",
        kind: "line",
        startLine: lineNumber,
        endLine: lineNumber,
      });
    }
  }
  if (open !== null) hooks.push({ ...open, kind: "jsx", endLine: lines.length });
  return hooks;
};

/** A well-formed manifest key: `<domain>/<name>` with known domain segments. */
export const isWellFormedForkHookKey = (key: string): boolean => {
  const match = /^([\w-]+)\/([\w-]+)$/.exec(key);
  return (
    match !== null &&
    (FORK_DOMAINS as readonly string[]).includes(match[1] ?? "") &&
    (match[2] ?? "").length > 0
  );
};
