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
  // custom-agents — marked on RSI-Software/t3code-hyprws#963; test seams marked on RSI-Software/t3code-hyprws#674 PR 2.
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
  // zmux-estate — marked on RSI-Software/t3code-hyprws#962.
  "zmux-estate/decider-checkout-move-import": {
    path: "apps/server/src/orchestration/decider.ts",
    anchor: { kind: "import-block" },
  },
  "zmux-estate/decider-checkout-move-dispatch": {
    path: "apps/server/src/orchestration/decider.ts",
    anchor: { kind: "after-decl", symbol: "decideOrchestrationCommand" },
  },
  "zmux-estate/decider-turn-start-checkout-move-guard": {
    path: "apps/server/src/orchestration/decider.ts",
    anchor: { kind: "after-decl", symbol: "targetThread" },
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
  // upstream-fixes — pull-request media upload marked on RSI-Software/t3code-hyprws#957.
  "upstream-fixes/pr-editor-attachment-import": {
    path: "apps/web/src/components/pullRequest/PullRequestMarkdownEditor.tsx",
    anchor: { kind: "import-block" },
  },
  "upstream-fixes/pr-editor-attachment": {
    path: "apps/web/src/components/pullRequest/PullRequestMarkdownEditor.tsx",
    anchor: { kind: "after-decl", symbol: "seed" },
  },
  "upstream-fixes/pr-editor-attachment-textarea": {
    path: "apps/web/src/components/pullRequest/PullRequestMarkdownEditor.tsx",
    anchor: { kind: "jsx-parent", symbol: "Textarea" },
  },
  "upstream-fixes/pr-editor-attachment-bar": {
    path: "apps/web/src/components/pullRequest/PullRequestMarkdownEditor.tsx",
    anchor: { kind: "jsx-parent", symbol: "PullRequestMarkdownEditor" },
  },
  "upstream-fixes/pr-attachment-rpc-import": {
    path: "packages/contracts/src/rpc.ts",
    anchor: { kind: "import-block" },
  },
  "upstream-fixes/pr-attachment-rpc-methods": {
    path: "packages/contracts/src/rpc.ts",
    anchor: { kind: "collection", symbol: "WS_METHODS" },
  },
  "upstream-fixes/pr-attachment-rpc-group": {
    path: "packages/contracts/src/rpc.ts",
    anchor: { kind: "collection", symbol: "WsRpcGroup" },
  },
  // upstream-fixes — composer refocus folded into the window-focus predicate on RSI-Software/t3code-hyprws#956.
  "upstream-fixes/composer-refocus-import": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "import-block" },
  },
  "upstream-fixes/composer-refocus-predicate": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "after-decl", symbol: "focusComposer" },
  },
  "upstream-fixes/terminal-focus-gate": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "after-call", symbol: "useThreadShell" },
  },
  "upstream-fixes/terminal-focus-gate-request": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "after-call", symbol: "useTerminalFocusGateFork" },
  },
  "upstream-fixes/terminal-focus-intent-drawer": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "after-call", symbol: "setTerminalFocusRequestId" },
  },
  "upstream-fixes/terminal-focus-intent-panel": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "after-call", symbol: "setTerminalFocusRequestId" },
  },
  "upstream-fixes/terminal-focus-command": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "after-call", symbol: "pinThread" },
  },
  "upstream-fixes/drawer-open-focus-request": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "after-call", symbol: "setTerminalOpen" },
  },
  "upstream-fixes/drawer-focus-reset": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "after-decl", symbol: "localFocusRequestId" },
  },
  "upstream-fixes/thread-terminal-focus-import": {
    path: "apps/web/src/components/ThreadTerminalDrawer.tsx",
    anchor: { kind: "import-block" },
  },
  "upstream-fixes/thread-terminal-focus-command-set": {
    path: "apps/web/src/components/ThreadTerminalDrawer.tsx",
    anchor: { kind: "collection", symbol: "THREAD_TERMINAL_WINDOW_COMMANDS" },
  },
  "upstream-fixes/terminal-focus-handled-ref": {
    path: "apps/web/src/components/ThreadTerminalDrawer.tsx",
    anchor: { kind: "after-decl", symbol: "hasHandledExitRef" },
  },
  "upstream-fixes/terminal-focus-pending-ref": {
    path: "apps/web/src/components/ThreadTerminalDrawer.tsx",
    anchor: { kind: "after-decl", symbol: "hasHandledExitRef" },
  },
  "upstream-fixes/terminal-focus-attach-gate": {
    path: "apps/web/src/components/ThreadTerminalDrawer.tsx",
    anchor: { kind: "after-call", symbol: "synchronizeTerminalStatus" },
  },
  "upstream-fixes/terminal-focus-attach-consume": {
    path: "apps/web/src/components/ThreadTerminalDrawer.tsx",
    anchor: { kind: "after-call", symbol: "synchronizeTerminalStatus" },
  },
  "upstream-fixes/terminal-focus-request-gate": {
    path: "apps/web/src/components/ThreadTerminalDrawer.tsx",
    anchor: { kind: "after-call", symbol: "shouldHandleTerminalFocusRequest" },
  },
  "upstream-fixes/terminal-focus-request-consume": {
    path: "apps/web/src/components/ThreadTerminalDrawer.tsx",
    anchor: { kind: "after-call", symbol: "shouldHandleTerminalFocusRequest" },
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
  "github-issues/issue-link-claim": {
    path: "apps/web/src/lib/openPullRequestLink.ts",
    anchor: { kind: "after-decl", symbol: "resolvedPanelRef" },
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

  // markdown-editing — marked on RSI-Software/t3code-hyprws#958.
  "markdown-editing/rich-preview-import": {
    path: "apps/web/src/components/files/FilePreviewPanel.tsx",
    anchor: { kind: "import-block" },
  },
  "markdown-editing/rich-preview-mode": {
    path: "apps/web/src/components/files/FilePreviewPanel.tsx",
    anchor: { kind: "after-decl", symbol: "revealHandled" },
  },
  "markdown-editing/rich-preview-rendered": {
    path: "apps/web/src/components/files/FilePreviewPanel.tsx",
    anchor: { kind: "after-decl", symbol: "renderMarkdown" },
  },
  "markdown-editing/rich-preview-toggle-props": {
    path: "apps/web/src/components/files/FilePreviewPanel.tsx",
    anchor: { kind: "jsx-parent", symbol: "FileSurfaceAction" },
  },
  "markdown-editing/rich-preview-icon": {
    path: "apps/web/src/components/files/FilePreviewPanel.tsx",
    anchor: { kind: "jsx-parent", symbol: "FileSurfaceAction" },
  },
  "markdown-editing/rich-preview-boundary": {
    path: "apps/web/src/components/files/FilePreviewPanel.tsx",
    anchor: { kind: "jsx-parent", symbol: "RenderedMarkdownSurface" },
  },

  // github-issues — marked on RSI-Software/t3code-hyprws#959 (commit `9f92309411`).
  "github-issues/rpc-import": {
    path: "packages/contracts/src/rpc.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/rpc-methods": {
    path: "packages/contracts/src/rpc.ts",
    anchor: { kind: "collection", symbol: "WS_METHODS" },
  },
  "github-issues/rpc-group": {
    path: "packages/contracts/src/rpc.ts",
    anchor: { kind: "collection", symbol: "WsRpcGroup" },
  },
  "github-issues/environment-capability": {
    path: "packages/contracts/src/environment.ts",
    anchor: { kind: "collection", symbol: "ExecutionEnvironmentCapabilities" },
  },
  "github-issues/contracts-reexport": {
    path: "packages/contracts/src/index.ts",
    anchor: { kind: "after-decl", symbol: "ExecutionEnvironmentCapabilities" },
  },
  "github-issues/ws-wiring-import": {
    path: "apps/server/src/ws.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/ws-service-import": {
    path: "apps/server/src/ws.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/ws-service-yield": {
    path: "apps/server/src/ws.ts",
    anchor: { kind: "after-decl", symbol: "pullRequestSync" },
  },
  "github-issues/ws-rpc-handlers": {
    path: "apps/server/src/ws.ts",
    anchor: { kind: "after-decl", symbol: "observeRpcStreamEffect" },
  },
  "github-issues/ws-route-service-yield": {
    path: "apps/server/src/ws.ts",
    anchor: { kind: "after-decl", symbol: "sql" },
  },
  "github-issues/ws-route-service-provide": {
    path: "apps/server/src/ws.ts",
    anchor: { kind: "after-call", symbol: "PullRequestService" },
  },
  "github-issues/server-wiring-import": {
    path: "apps/server/src/server.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/server-service-live": {
    path: "apps/server/src/server.ts",
    anchor: { kind: "after-decl", symbol: "commandReadinessLayer" },
  },
  "github-issues/server-service-provide": {
    path: "apps/server/src/server.ts",
    anchor: { kind: "after-call", symbol: "PullRequestServiceLive" },
  },
  "github-issues/rpc-auth-list": {
    path: "apps/server/src/auth/RpcAuthorization.ts",
    anchor: { kind: "collection", symbol: "RPC_REQUIRED_SCOPES" },
  },
  "github-issues/rpc-auth-detail": {
    path: "apps/server/src/auth/RpcAuthorization.ts",
    anchor: { kind: "collection", symbol: "RPC_REQUIRED_SCOPES" },
  },
  "github-issues/server-environment-capability": {
    path: "apps/server/src/environment/ServerEnvironment.ts",
    anchor: { kind: "collection", symbol: "capabilities" },
  },
  "github-issues/right-panel-surface-import": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/right-panel-surface": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "collection", symbol: "RightPanelSurface" },
  },
  "github-issues/right-panel-open-github-issue-decl": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "collection", symbol: "RightPanelStoreState" },
  },
  "github-issues/right-panel-open-github-issue-import": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/right-panel-open-github-issue": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "collection", symbol: "useRightPanelStore" },
  },
  "github-issues/right-panel-migrate-github-issue-import": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/right-panel-migrate-github-issue": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "after-decl", symbol: "normalizeRevealLine" },
  },
  "github-issues/right-panel-active-surface-import": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/right-panel-active-surface": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "after-decl", symbol: "migratePersistedRightPanelState" },
  },
  "github-issues/right-panel-active-kind-import": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "import-block" },
  },
  "github-issues/right-panel-active-kind": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "after-decl", symbol: "selectThreadRightPanelState" },
  },
  "github-issues/command-palette-import": {
    path: "apps/web/src/components/CommandPalette.tsx",
    anchor: { kind: "import-block" },
  },
  "github-issues/command-palette-entry": {
    path: "apps/web/src/components/CommandPalette.tsx",
    anchor: { kind: "after-decl", symbol: "buildIssuesNavigationCommand" },
  },
  "github-issues/command-palette-entry-push": {
    path: "apps/web/src/components/CommandPalette.tsx",
    anchor: { kind: "after-decl", symbol: "githubIssuesActionItem" },
  },
  "github-issues/sidebar-issues-icon": {
    path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    anchor: { kind: "collection", symbol: "lucide-react" },
  },
  "github-issues/sidebar-issues-supported-import": {
    path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    anchor: { kind: "import-block" },
  },
  "github-issues/sidebar-issues-supported": {
    path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    anchor: { kind: "after-decl", symbol: "pullRequestsSupported" },
  },
  "github-issues/sidebar-issues-footer-page-import": {
    path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    anchor: { kind: "import-block" },
  },
  "github-issues/sidebar-issues-footer-page": {
    path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    anchor: { kind: "after-decl", symbol: "currentFooterPage" },
  },
  "github-issues/sidebar-issues-navigate-import": {
    path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    anchor: { kind: "import-block" },
  },
  "github-issues/sidebar-issues-navigate": {
    path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    anchor: { kind: "after-decl", symbol: "handlePullRequestsClick" },
  },
  "github-issues/sidebar-issues-entry": {
    path: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    anchor: { kind: "jsx-parent", symbol: "SidebarUtilityMenu" },
  },
  "github-issues/chat-view-detail-import": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "import-block" },
  },
  "github-issues/chat-view-detail-surface": {
    path: "apps/web/src/components/ChatView.tsx",
    anchor: { kind: "jsx-parent", symbol: "GitHubIssueDetailSurfaceFork" },
  },
  "github-issues/panel-tab-title": {
    path: "apps/web/src/components/RightPanelTabs.tsx",
    anchor: { kind: "after-decl", symbol: "pull-requests" },
  },
  "github-issues/panel-tab-status-icon": {
    path: "apps/web/src/components/RightPanelTabs.tsx",
    anchor: { kind: "after-decl", symbol: "pull-requests" },
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

/** Literal state after scanning a prefix of the file: bracket depth and open string/template. */
interface LiteralScan {
  readonly depth: number;
  /** The open quote character, when the scan sits inside a string or template text. */
  readonly quote: string | null;
  /** Open `${` frames, each counting the `{` nested inside the interpolation. */
  readonly frames: ReadonlyArray<number>;
  /** The last significant code character seen outside strings and comments. */
  readonly lastCode: string;
}

const INITIAL_SCAN: LiteralScan = { depth: 0, quote: null, frames: [], lastCode: "" };

const scanLiteralLine = (line: string, start: LiteralScan): LiteralScan => {
  let { depth, quote, lastCode } = start;
  const frames = [...start.frames];
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
      } else if (quote === "`") {
        if (char === "`") quote = null;
        else if (char === "$" && line[index + 1] === "{") {
          index += 1;
          frames.push(0);
          quote = null;
        }
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && line[index + 1] === "/") break;
    if (char === "/" && line[index + 1] === "*") {
      const end = line.indexOf("*/", index + 2);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "{") {
      if (frames.length > 0) frames[frames.length - 1] = (frames[frames.length - 1] ?? 0) + 1;
      else depth += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      depth -= 1;
      continue;
    }
    if (char === "}") {
      const top = frames.length - 1;
      if (top >= 0 && (frames[top] ?? 0) === 0) {
        frames.pop();
        quote = "`";
      } else if (top >= 0) frames[top] = (frames[top] ?? 0) - 1;
      else depth -= 1;
    }
    if (char !== " " && char !== "\t") lastCode = char;
  }
  return { depth, quote, frames, lastCode };
};

const COMMENT_ONLY = /^(?:\/\/|\/\*|\*(?:\/|$))/;

/**
 * The first line (1-based) of the statement a trailing marker on `markerLine` closes, found by
 * walking backwards: while `()[]{}` brackets or string/template literals are still open, or the
 * previous line neither ends a statement (`;`, `{`, `,` as the last code character outside any
 * literal, or a balanced `}` closing a block) nor is blank or
 * comment-only, the statement continues upward. `null` when the start cannot be proven — the
 * marker sits inside a string or template text, or a stray close leaves the file unbalanced.
 * Pure and line-based; there is deliberately no parser dependency.
 */
export const statementStartLine = (
  lines: ReadonlyArray<string>,
  markerLine: number,
): number | null => {
  const states: Array<LiteralScan> = [];
  let state = INITIAL_SCAN;
  for (const line of lines) {
    states.push(state);
    state = scanLiteralLine(line, state);
  }
  const index = markerLine - 1;
  const entered = states[index];
  if (entered === undefined) return null;
  // A marker inside a string or template text, or a file already unbalanced before it, is
  // unprovable. An open `${` frame is code, not text — the walk still applies.
  if (entered.quote !== null || entered.depth < 0) return null;
  let at = index;
  while (at > 0) {
    const previous = states[at];
    if (previous === undefined) return null;
    if (previous.depth < 0) return null;
    // A blank or comment-only line, or a top-level statement terminator, only ends the walk when
    // no bracket or literal is still open across it; inside an open construct the walk continues.
    if (previous.depth === 0 && previous.quote === null && previous.frames.length === 0) {
      const text = (lines[at - 1] ?? "").trim();
      if (text === "" || COMMENT_ONLY.test(text)) break;
      if (
        previous.lastCode === ";" ||
        previous.lastCode === "{" ||
        previous.lastCode === "," ||
        previous.lastCode === "}"
      )
        break;
    }
    at -= 1;
  }
  const start = states[at];
  if (start === undefined || start.depth !== 0 || start.quote !== null || start.frames.length > 0)
    return null;
  return at + 1;
};

/**
 * Every marker in one file's text, in source order. A line marker covers the whole statement it
 * closes, walked back from the marker line; a JSX open marker covers through the next end marker (or end of
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
      // The marker covers the whole statement it closes; an unprovable start is the same
      // refusal a malformed marker gets — the marker marks nothing.
      const startLine = statementStartLine(lines, lineNumber);
      if (startLine === null) continue;
      hooks.push({
        key: forkHookKey(line1[1] ?? "", line1[2] ?? ""),
        domain: line1[1] ?? "",
        name: line1[2] ?? "",
        kind: "line",
        startLine,
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
