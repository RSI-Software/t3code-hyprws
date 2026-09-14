// The fork-hook manifest. An upstream file may carry hook lines only: fork code
// woven elsewhere is a woven seam and `fork-hook-seam` warns on it. Each hook
// is marked in source so a tool can find it, and listed here so a marker without
// a manifest entry — a hook the sync walk cannot reason about — is visible.
//
// Two marker forms:
//
// - a trailing `// fork-hook: <domain>/<name>` on a one-line hook (an import,
//   a call, a `const`, a property/spread);
// - `{/* fork-hook: <domain>/<name> */}` … `{/* fork-hook-end *` + `/}`
//   (the end-marker JSX comment) around a multi-line JSX construct.
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
  // custom-agents — marked on RSI-Software/t3code-hyprws#963.
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
  "custom-agents/composer-state-agent-import": {
    path: "apps/web/src/components/chat/composerProviderState.tsx",
    anchor: { kind: "import-block" },
  },
  "custom-agents/composer-state-agent-menu-content": {
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
  "custom-agents/right-panel-open-agents": {
    path: "apps/web/src/rightPanelStore.ts",
    anchor: { kind: "collection", symbol: "useRightPanelStore" },
  },
};

export const forkHookKey = (domain: string, name: string): string => `${domain}/${name}`;

// The comment must close the line: a marker mid-comment marks nothing.
export const FORK_HOOK_LINE_MARKER = /^\/\/\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*$/;
export const FORK_HOOK_LINE_SUFFIX = /\s+\/\/\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*$/;
export const FORK_HOOK_JSX_OPEN = /\{\/\*\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*\*\/\}/;
export const FORK_HOOK_JSX_END = /\{\/\*\s*fork-hook-end\s*\*\/\}/;

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
    const line1 = FORK_HOOK_LINE_SUFFIX.exec(line);
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
