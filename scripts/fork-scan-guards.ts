// Authoring guards for `vp run fork:scan`, derived from what the churn ledger
// already charged us for. Each rule names a shape a later rebase pays for, at
// the moment a fork commit creates it rather than three walks later:
//
// - hot-seam: the commit touches a path the churn ledger lists as a hot seam.
// - upstream-test: the commit adds a fork test block to an upstream-owned test
//   file instead of its `*.fork.test.ts` sibling.
// - footprint: one commit spreads over more upstream files than the budget.
// - replaced-export: the commit deletes an upstream-owned exported declaration
//   and re-declares it, so every later upstream edit to it lands invisibly.
// - lockfile: the commit carries a lockfile change.
// - terminal-attachment-boundary: fork retention state grows inside upstream's
//   terminal metadata/index module instead of its fork-owned hook.
//
// Warnings are advisory. `fork:scan --strict` is what turns them fatal, so a
// rule can ship before the stack it describes is clean.

import { lessonHotSeams, readLessonEvidence } from "./fork-lesson-guidance.ts";

// `#73` spans 12 hunks over 6 files in the v0.0.39-nightly.20260902.1256
// census, the largest footprint the ledger has had to replay by hand.
export const UPSTREAM_FOOTPRINT_BUDGET = 6;

export type ScanWarningRule =
  | "hot-seam"
  | "upstream-test"
  | "footprint"
  | "replaced-export"
  | "provider-agent-boundary"
  | "agent-spawn-navigation"
  | "rich-markdown-boundary"
  | "lockfile"
  | "sidebar-physical-scope"
  | "pull-request-project-scope"
  | "terminal-attachment-boundary"
  | "thread-route-navigation"
  | "github-issue-settings-search"
  | "mobile-ignored-file-listing";

// Exact integration targets used by the real matchers and the lesson-guidance
// coverage invariant. Upstream test ownership is a separate generic policy.
export const AUTHORING_GUARD_TARGETS = {
  "terminal-attachment-boundary": { metadata: "apps/web/src/state/terminalSessions.ts" },
  "provider-agent-boundary": {
    claude: "apps/server/src/provider/Layers/ClaudeProvider.ts",
    codex: "apps/server/src/provider/Layers/CodexProvider.ts",
  },
  "sidebar-physical-scope": {
    sidebar: "apps/web/src/components/Sidebar.tsx",
    legacy: "apps/web/src/components/LegacySidebar.tsx",
  },
  "thread-route-navigation": {
    chat: "apps/web/src/components/ChatView.tsx",
    palette: "apps/web/src/components/CommandPalette.tsx",
    newThread: "apps/web/src/hooks/useHandleNewThread.ts",
  },
  "pull-request-project-scope": {
    route: "apps/web/src/routes/_chat.pull-requests.tsx",
    filters: "apps/web/src/components/pullRequest/PullRequestListFilters.tsx",
    shell: "apps/web/src/state/shell.ts",
    retiredParser: "apps/web/src/components/pullRequest/pullRequestListRoute.ts",
  },
  "github-issue-settings-search": {
    registry: "apps/web/src/components/settings/settingsSearch.ts",
  },
  "mobile-ignored-file-listing": {
    route: "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
  },
  "agent-spawn-navigation": { timeline: "apps/web/src/components/chat/MessagesTimeline.tsx" },
  "rich-markdown-boundary": {
    preview: "apps/web/src/components/files/FilePreviewPanel.tsx",
    links: "apps/web/src/markdown-links.ts",
  },
} as const satisfies Partial<Record<ScanWarningRule, Readonly<Record<string, string>>>>;

const TERMINAL_METADATA_PATH = AUTHORING_GUARD_TARGETS["terminal-attachment-boundary"].metadata;
const AGENT_SPAWN_TIMELINE = AUTHORING_GUARD_TARGETS["agent-spawn-navigation"].timeline;

const authoringTargetPaths = new Map(
  Object.entries(AUTHORING_GUARD_TARGETS).map(([rule, paths]) => [
    rule,
    new Set<string>(Object.values(paths)),
  ]),
);
const isAuthoringGuardTarget = (
  rule: keyof typeof AUTHORING_GUARD_TARGETS,
  path: string,
): boolean => authoringTargetPaths.get(rule)?.has(path) ?? false;

// Adopted boundaries are enforced on the commits an authoring scan selects.
// Historical inventory remains advisory so its original patches can be repaired
// in the controlled replay lane without unrelated old warnings blocking authors.
export const ADOPTED_AUTHORING_GUARDS: ReadonlySet<ScanWarningRule> = new Set([
  "terminal-attachment-boundary",
  "provider-agent-boundary",
  "sidebar-physical-scope",
  "thread-route-navigation",
  "pull-request-project-scope",
  "upstream-test",
  "github-issue-settings-search",
  "mobile-ignored-file-listing",
  "agent-spawn-navigation",
  "rich-markdown-boundary",
]);

const RULE_ORDER: ReadonlyArray<ScanWarningRule> = [
  "hot-seam",
  "upstream-test",
  "footprint",
  "replaced-export",
  "rich-markdown-boundary",
  "provider-agent-boundary",
  "sidebar-physical-scope",
  "agent-spawn-navigation",
  "lockfile",
  "terminal-attachment-boundary",
  "thread-route-navigation",
  "pull-request-project-scope",
  "github-issue-settings-search",
  "mobile-ignored-file-listing",
];

export interface ScanWarning {
  readonly rule: ScanWarningRule;
  readonly commit: string;
  readonly domain: string;
  readonly detail: string;
}

export interface HotSeam {
  readonly walkCount: number;
  readonly countUnit?: string;
  readonly worstClass: string;
}

export interface ExportDeclaration {
  readonly path: string;
  readonly kind: string;
  readonly name: string;
}

export interface TestBlockHunk {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

export interface CommitPatch {
  readonly sidebarPhysicalScopeAdded?: boolean;
  readonly removedExports: ReadonlyArray<ExportDeclaration>;
  readonly addedExports: ReadonlyArray<ExportDeclaration>;
  // `it`/`test`/`describe` block openers stay grouped by zero-context diff
  // hunk, so only a nearby removal can identify an addition as a replacement.
  readonly testBlockHunks: ReadonlyArray<TestBlockHunk>;
  readonly terminalAttachmentStateAdded?: boolean;
  readonly providerAgentImplementationAdded?: boolean;
  readonly threadRouteNavigationAdded?: boolean;
  readonly pullRequestProjectScopeAdded?: boolean;
  readonly githubIssueSettingsSearchAdded?: boolean;
  readonly mobileIgnoredFilePolicyAdded?: boolean;
  readonly agentSpawnNavigationAdded?: boolean;
  readonly richMarkdownImplementationAdded?: boolean;
}

export interface GuardCommit {
  readonly sha: string;
  readonly short: string;
  readonly domain: string;
}

export interface GuardInput {
  // Only the commits the caller wants warned about: `--since` narrows a walk of
  // the whole stack to the commits one change introduces.
  readonly commits: ReadonlyArray<GuardCommit>;
  readonly filesBySha: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly patchesBySha: ReadonlyMap<string, CommitPatch>;
  // Paths that exist in the upstream base tree. A fork-created file is the
  // repair every one of these rules points at, so it never triggers them.
  readonly upstreamFiles: ReadonlySet<string>;
  // Test ownership follows the selected target, including independent same-path
  // additions. Other footprint/export guards retain their upstream-base meaning.
  readonly upstreamTestFiles?: ReadonlySet<string>;
  readonly hotSeams: ReadonlyMap<string, HotSeam>;
}

const PATCH_RECORD_SEPARATOR = "";

export const commitPatchArguments = (shas: ReadonlyArray<string>) =>
  [
    "-c",
    "core.quotePath=false",
    "show",
    "--no-ext-diff",
    "--unified=0",
    `--format=${PATCH_RECORD_SEPARATOR}%H`,
    ...shas,
  ] as const;

// A declaration line, not a re-export: `export { x } from "./y"` carries no
// body upstream can extend, so it is not the shape that loses upstream work.
const EXPORT_DECLARATION =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(const|let|var|function|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/;

// effectIt is the repository's @effect/vitest alias beside vite-plus/test's it.
const TEST_BLOCK = /^\s*(?:it|test|describe|effectIt)\s*(?:\.[\w$]+)*\s*(?:<[^>]*>)?\s*[(`]/;

// Keep the check scoped to added state/effect calls and the old inline state
// declarations. Upstream memoized metadata indexing and the retained hook call
// remain free to evolve without triggering it.
const TERMINAL_ATTACHMENT_STATE =
  /\b(?:useState|useEffect)\s*(?:<[^>]*>)?\s*\(|\b(?:interface|type)\s+RetainedTerminalAttachmentState\b|\b(?:function|const)\s+updateRetainedTerminalAttachment\b/;

// Keep provider-specific agent normalization/options out of upstream provider
// setup. Imports and adapter calls are the intended, small integration seam.
const PROVIDER_AGENT_DECLARATION =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+(?:parseClaudeInitializationAgents|withClaudeAgentOptions|withCodexAgentOptions)\b/;
// Added import blocks may span lines. Calls through threadRouteNavigation stay
// valid, including execution-time reads of current params after async work.
const THREAD_NAVIGATION_IMPORT =
  /\bimport\s*\{[^}]*\bresolveThreadRouteFamily\b[^}]*\}\s*from\s*["'](?:\.\.\/)+threadRoutes(?:\.ts)?["']/;
const THREAD_NAVIGATION_SELECTION =
  /\bselect\s*:\s*(?:\([^)]*\)|\w+)\s*=>\s*(?:\{\s*return\s+)?resolveThreadRouteFamily\s*\(/;
const THREAD_NAVIGATION_DECLARATION = /\b(?:function|const|let)\s+resolveThreadRouteFamily\b/;
// These are the original scope rewrite's policy branches, not upstream list
// filtering or the adapter's narrow calls. The removed search module duplicated
// the upstream route validator; its original path must stay retired.
const isPullRequestProjectScopeAddition = (path: string, content: string): boolean => {
  const targets = AUTHORING_GUARD_TARGETS["pull-request-project-scope"];
  if (/^\s*(?:\/\/|\/\*|\*)/.test(content) || content.trim().length === 0) return false;
  if (path === targets.retiredParser) return true;
  if (path === targets.shell)
    return /\b(?:const|function)\s+environmentShellBootstrappedAtom\b/.test(content);
  if (path === targets.route) {
    return (
      /\b(?:const|let)\s+forcedProjectScope\b/.test(content) ||
      /\bforcedProject(?:Scope|Ref)\s*\?*\.\s*(?:environmentId|projectId)\b/.test(content) ||
      /["'][^"']*\/pullRequestListRoute(?:\.ts)?["']/.test(content)
    );
  }
  return path === targets.filters && /\bprojects\s*(?:===?|!==?)\s*null\b/.test(content);
};

// The timeline keeps CTA presentation and widened callback arguments. Target
// selection and its click closure belong behind AgentSpawnNavigation's handler.
const AGENT_SPAWN_SELECTION =
  /\bresolveAgentSpawnOpenTarget\b|\bopenTarget\s*\.\s*(?:selectedAgentId|rosterFocusAgentId)\b/;

// The preview owns the narrow boundary mount; editor loading and document-link
// normalization stay in their fork modules. Calls to the shared resolver remain valid.
const isRichMarkdownImplementation = (path: string, content: string): boolean => {
  const targets = AUTHORING_GUARD_TARGETS["rich-markdown-boundary"];
  if (/^\s*(?:\/\/|\/\*|\*)/.test(content)) return false;
  if (path === targets.links) {
    return /\b(?:function|const|let|var)\s+normalizeDotSegments\b/.test(content);
  }
  if (path !== targets.preview) return false;
  return (
    /["'](?:@milkdown\/[^"']+|(?:\.\/|~\/components\/files\/)MarkdownRichEditor(?:\.tsx)?)["']/.test(
      content,
    ) ||
    /\b(?:function|const|let|var)\s+RichMarkdown(?:Editor)?Surface\b/.test(content) ||
    /<RichMarkdown(?:Editor)?Surface\b/.test(content)
  );
};

const diffPath = (value: string): string | null => {
  const target = value.trim();
  return target === "/dev/null" ? null : target.replace(/^[ab]\//, "");
};

export const parseCommitPatches = (raw: string): ReadonlyMap<string, CommitPatch> => {
  const patches = new Map<string, CommitPatch>();
  for (const record of raw.replace(/\r\n/g, "\n").split(PATCH_RECORD_SEPARATOR)) {
    const [header = "", ...lines] = record.split("\n");
    const sha = header.trim();
    if (sha.length === 0) continue;
    const removedExports: Array<ExportDeclaration> = [];
    const addedExports: Array<ExportDeclaration> = [];
    const testBlockHunks: Array<TestBlockHunk> = [];
    let terminalAttachmentStateAdded = false;
    let providerAgentImplementationAdded = false;
    let sidebarPhysicalScopeAdded = false;
    const navigationAdditions = new Map<string, Array<string>>();
    let pullRequestProjectScopeAdded = false;
    let githubIssueSettingsSearchAdded = false;
    let mobileIgnoredFilePolicyAdded = false;
    let agentSpawnNavigationAdded = false;
    let richMarkdownImplementationAdded = false;
    // A deletion writes `+++ /dev/null`, so removals are attributed to the
    // source side and additions to the target side rather than to one path.
    let sourcePath: string | null = null;
    let targetPath: string | null = null;
    let hunkAddedTestBlocks = 0;
    let hunkRemovedTestBlocks = 0;
    const flushTestBlockHunk = () => {
      const path = targetPath ?? sourcePath;
      if (path !== null && (hunkAddedTestBlocks > 0 || hunkRemovedTestBlocks > 0)) {
        testBlockHunks.push({
          path,
          added: hunkAddedTestBlocks,
          removed: hunkRemovedTestBlocks,
        });
      }
      hunkAddedTestBlocks = 0;
      hunkRemovedTestBlocks = 0;
    };
    for (const line of lines) {
      if (line.startsWith("--- ")) {
        flushTestBlockHunk();
        sourcePath = diffPath(line.slice(4));
        continue;
      }
      if (line.startsWith("+++ ")) {
        targetPath = diffPath(line.slice(4));
        continue;
      }
      if (line.startsWith("@@")) {
        flushTestBlockHunk();
        continue;
      }
      const added = line.startsWith("+");
      if (!added && !line.startsWith("-")) continue;
      const path = added ? targetPath : sourcePath;
      if (path === null) continue;
      const content = line.slice(1);
      if (
        added &&
        isAuthoringGuardTarget("thread-route-navigation", path) &&
        !/^\s*(?:\/\/|\/\*|\*)/.test(content)
      ) {
        const additions = navigationAdditions.get(path) ?? [];
        additions.push(content);
        navigationAdditions.set(path, additions);
      }
      if (
        added &&
        isAuthoringGuardTarget("agent-spawn-navigation", path) &&
        !/^\s*(?:\/\/|\/\*|\*)/.test(content) &&
        AGENT_SPAWN_SELECTION.test(content)
      ) {
        agentSpawnNavigationAdded = true;
      }
      if (added && isRichMarkdownImplementation(path, content))
        richMarkdownImplementationAdded = true;
      if (
        added &&
        isAuthoringGuardTarget("terminal-attachment-boundary", path) &&
        TERMINAL_ATTACHMENT_STATE.test(content)
      )
        terminalAttachmentStateAdded = true;
      if (
        added &&
        isAuthoringGuardTarget("provider-agent-boundary", path) &&
        PROVIDER_AGENT_DECLARATION.test(content)
      ) {
        providerAgentImplementationAdded = true;
      }
      if (
        added &&
        isAuthoringGuardTarget("sidebar-physical-scope", path) &&
        !/^\s*(?:\/\/|\*)/.test(content) &&
        (/\bforcedProjectRef\s*\?*\.\s*(?:environmentId|projectId)\b/.test(content) ||
          /\b(?:const|let)\s+forcedProjectGroup\b/.test(content))
      ) {
        sidebarPhysicalScopeAdded = true;
      }
      if (added && isPullRequestProjectScopeAddition(path, content))
        pullRequestProjectScopeAdded = true;
      if (
        added &&
        isAuthoringGuardTarget("github-issue-settings-search", path) &&
        !/^\s*(?:\/\/|\/\*|\*)/.test(content) &&
        /(?:\bid|["']id["'])\s*:\s*["']github-issue-handoff-prompt["']/.test(content)
      )
        githubIssueSettingsSearchAdded = true;
      if (
        added &&
        isAuthoringGuardTarget("mobile-ignored-file-listing", path) &&
        !/^\s*(?:\/\/|\/\*|\*)/.test(content) &&
        /\b(?:showIgnoredFiles|includeIgnored)\b/.test(content)
      )
        mobileIgnoredFilePolicyAdded = true;
      const declaration = EXPORT_DECLARATION.exec(content);
      if (declaration !== null) {
        (added ? addedExports : removedExports).push({
          path,
          kind: declaration[1] ?? "",
          name: declaration[2] ?? "",
        });
      }
      if (TEST_BLOCK.test(content)) {
        if (added) hunkAddedTestBlocks += 1;
        else hunkRemovedTestBlocks += 1;
      }
    }
    flushTestBlockHunk();
    const threadRouteNavigationAdded = [...navigationAdditions.values()].some((lines) => {
      const added = lines.join("\n");
      return (
        THREAD_NAVIGATION_IMPORT.test(added) ||
        THREAD_NAVIGATION_SELECTION.test(added) ||
        THREAD_NAVIGATION_DECLARATION.test(added)
      );
    });
    patches.set(sha, {
      removedExports,
      addedExports,
      testBlockHunks,
      ...(terminalAttachmentStateAdded ? { terminalAttachmentStateAdded: true } : {}),
      ...(providerAgentImplementationAdded ? { providerAgentImplementationAdded: true } : {}),
      ...(sidebarPhysicalScopeAdded ? { sidebarPhysicalScopeAdded } : {}),
      ...(threadRouteNavigationAdded ? { threadRouteNavigationAdded: true } : {}),
      ...(pullRequestProjectScopeAdded ? { pullRequestProjectScopeAdded: true } : {}),
      ...(githubIssueSettingsSearchAdded ? { githubIssueSettingsSearchAdded: true } : {}),
      ...(mobileIgnoredFilePolicyAdded ? { mobileIgnoredFilePolicyAdded: true } : {}),
      ...(agentSpawnNavigationAdded ? { agentSpawnNavigationAdded: true } : {}),
      ...(richMarkdownImplementationAdded ? { richMarkdownImplementationAdded: true } : {}),
    });
  }
  return patches;
};

export const readHotSeams = (churnLedger: string): ReadonlyMap<string, HotSeam> =>
  lessonHotSeams(readLessonEvidence(churnLedger));

// `pnpm-lock.yaml`, `package-lock.json`, `bun.lock`, `Cargo.lock`, `uv.lock`.
const LOCKFILE = /(?:^|\/)(?:[^/]*-lock\.[^/.]+|[^/]*\.lock)$/;

const TEST_FILE = /\.test\.tsx?$/;
const FORK_TEST_FILE = /\.fork\.test\.tsx?$/;

// These two upstream test modules build their integration harnesses in file-local
// scope. Importing an exported helper also registers the upstream suites in the
// sibling, while extracting the complete harness would turn a narrow test move
// into a broad, duplicated harness seam. Keep this list exact and evidence-backed
// in fork-development.md.
export const UPSTREAM_TEST_FILE_LOCAL_HARNESS_DEFERRALS = new Set([
  "apps/desktop/src/window/DesktopWindow.test.ts",
  "apps/server/src/server.test.ts",
]);

export const forkTestSibling = (path: string): string =>
  path.replace(/\.test\.(tsx?)$/, ".fork.test.$1");

const EMPTY_PATCH: CommitPatch = {
  removedExports: [],
  addedExports: [],
  testBlockHunks: [],
};

export const collectScanWarnings = (input: GuardInput): ReadonlyArray<ScanWarning> => {
  const warnings: Array<ScanWarning> = [];

  for (const commit of input.commits) {
    const files = input.filesBySha.get(commit.sha) ?? [];
    const patch = input.patchesBySha.get(commit.sha) ?? EMPTY_PATCH;
    const upstreamTouched = files.filter((path) => input.upstreamFiles.has(path)).toSorted();
    const found: Array<ScanWarning> = [];
    const warn = (rule: ScanWarningRule, detail: string) => {
      found.push({ rule, commit: commit.short, domain: commit.domain, detail });
    };
    if (patch.sidebarPhysicalScopeAdded) {
      warn(
        "sidebar-physical-scope",
        "physical project matching belongs in sidebar/SidebarPhysicalScope; keep upstream grouping, selection, search and ordering at their existing derivation points",
      );
    }

    if (patch.terminalAttachmentStateAdded) {
      warn(
        "terminal-attachment-boundary",
        `${TERMINAL_METADATA_PATH} gains attachment retention state; keep it in terminalAttachmentRetention.fork.ts and preserve upstream metadata indexing and tests`,
      );
    }
    if (patch.providerAgentImplementationAdded) {
      warn(
        "provider-agent-boundary",
        "ClaudeProvider.ts/CodexProvider.ts gains fork agent normalization or model-option implementation; keep it in the provider-specific *AgentOptions.fork.ts sibling and retain only the integration call",
      );
    }
    if (patch.pullRequestProjectScopeAdded) {
      warn(
        "pull-request-project-scope",
        "physical pull-request scope belongs in PullRequestProjectScope and scoped readiness in windowProjectBootstrap.fork.ts; preserve upstream route search, filter options, sorting and all-environment bootstrap, and reuse the hub validator instead of restoring pullRequestListRoute",
      );
    }
    if (patch.agentSpawnNavigationAdded) {
      warn(
        "agent-spawn-navigation",
        `${AGENT_SPAWN_TIMELINE} gains fork child-work target selection; keep it in AgentSpawnNavigation.ts and retain createAgentSpawnOpenHandler with upstream CTA markup`,
      );
    }

    if (patch.threadRouteNavigationAdded) {
      warn(
        "thread-route-navigation",
        "ChatView.tsx/CommandPalette.tsx/useHandleNewThread.ts gains direct route-family policy; use lib/threadRouteNavigation and retain execution-time parameter reads at navigation sites",
      );
    }
    if (patch.richMarkdownImplementationAdded) {
      warn(
        "rich-markdown-boundary",
        "keep rich editor imports and surface implementation in RichMarkdownPreviewBoundary.tsx, and normalizeDotSegments in richMarkdownEditorLinks.ts; preserve upstream preview and shared link behavior",
      );
    }

    if (patch.githubIssueSettingsSearchAdded) {
      warn(
        "github-issue-settings-search",
        "register the issue handoff item in githubIssueSettingsSearch.ts through useAvailableSettingsSearchItems; preserve upstream settingsSearch.ts items, availability and ordering",
      );
    }

    if (patch.mobileIgnoredFilePolicyAdded) {
      warn(
        "mobile-ignored-file-listing",
        "keep ignored-file preference and includeIgnored request policy in ignoredWorkspaceFileListing.ts; the route calls useIgnoredWorkspaceFileListing(cwd) and retains its environment and file-inspector gates",
      );
    }

    for (const path of upstreamTouched) {
      const seam = input.hotSeams.get(path);
      if (seam === undefined) continue;
      warn(
        "hot-seam",
        `${path} is a retained seam (${seam.walkCount} ${seam.countUnit ?? "conflict walk(s)"}, ${seam.worstClass}); use the declared lesson inventory and preferred boundary printed by this scan`,
      );
    }

    const appendedTestBlocks = new Map<string, number>();
    for (const hunk of patch.testBlockHunks) {
      const count = Math.max(0, hunk.added - hunk.removed);
      if (count === 0) continue;
      appendedTestBlocks.set(hunk.path, (appendedTestBlocks.get(hunk.path) ?? 0) + count);
    }
    for (const [path, count] of [...appendedTestBlocks].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!(input.upstreamTestFiles ?? input.upstreamFiles).has(path)) continue;
      if (!TEST_FILE.test(path) || FORK_TEST_FILE.test(path)) continue;
      if (UPSTREAM_TEST_FILE_LOCAL_HARNESS_DEFERRALS.has(path)) continue;
      warn(
        "upstream-test",
        `${path} gains ${count} fork test block(s); move them to ${forkTestSibling(path)}`,
      );
    }

    if (upstreamTouched.length > UPSTREAM_FOOTPRINT_BUDGET) {
      warn(
        "footprint",
        `${upstreamTouched.length} upstream file(s) in one commit (budget ${UPSTREAM_FOOTPRINT_BUDGET}); prefer one adapter boundary over edits spread across upstream files`,
      );
    }

    // The re-declaration is matched by name across the whole commit: moving an
    // upstream declaration into a fork-owned file is the common form of this
    // loss, and it leaves the upstream declaration deleted just the same.
    const reported = new Set<string>();
    for (const removed of patch.removedExports) {
      if (!input.upstreamFiles.has(removed.path)) continue;
      const key = `${removed.path}\0${removed.name}`;
      if (reported.has(key)) continue;
      const readded = patch.addedExports.find((added) => added.name === removed.name);
      if (readded === undefined) continue;
      reported.add(key);
      warn(
        "replaced-export",
        `${removed.kind} ${removed.name} is deleted from ${removed.path} and re-declared in ${readded.path}; extend it from a fork-owned sibling and leave the upstream declaration in place`,
      );
    }

    // No fork domain owns dependency bumps, so there is no trailer that makes a
    // lockfile change expected. Every one warns until a domain claims them: a
    // fork worktree installs with `vp i --frozen-lockfile`, and a real bump is
    // its own commit under the domain that needs the dependency.
    for (const path of files.toSorted()) {
      if (!LOCKFILE.test(path)) continue;
      warn(
        "lockfile",
        `${path} changes in a ${commit.domain} commit; install with \`vp i --frozen-lockfile\` and keep a real dependency change in its own commit`,
      );
    }

    warnings.push(
      ...found.toSorted(
        (left, right) => RULE_ORDER.indexOf(left.rule) - RULE_ORDER.indexOf(right.rule),
      ),
    );
  }

  return warnings;
};

export const renderScanWarnings = (warnings: ReadonlyArray<ScanWarning>): ReadonlyArray<string> => {
  if (warnings.length === 0) return [];
  const counts = RULE_ORDER.map(
    (rule) => [rule, warnings.filter((warning) => warning.rule === rule).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([rule, count]) => `${rule}: ${count}`)
    .join(", ");
  return [
    "",
    `Ledger guards, ${warnings.length} warning(s) (${counts}):`,
    ...warnings.map(
      (warning) =>
        `  WARN  ${warning.rule}  ${warning.commit}  ${warning.domain}  ${warning.detail}`,
    ),
  ];
};
