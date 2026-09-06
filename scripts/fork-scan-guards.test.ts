import { assert, it } from "@effect/vitest";

import {
  collectScanWarnings,
  commitPatchArguments,
  forkTestSibling,
  parseCommitPatches,
  readHotSeams,
  renderScanWarnings,
  significantTestLines,
  UPSTREAM_FOOTPRINT_BUDGET,
  UPSTREAM_TEST_FILE_LOCAL_HARNESS_DEFERRALS,
  type GuardInput,
} from "./fork-scan-guards.ts";

const RS = "";

const patch = (sha: string, body: string) => `${RS}${sha}\n${body}`;

// Two walks conflict on ChatView.tsx, one on quiet.ts: only the first is hot.
const churn = JSON.stringify([
  {
    tag: "v0.0.38",
    before: "1111111",
    after: "2222222",
    recordUrl: "https://example.invalid/1",
    conflicts: [
      {
        path: "apps/web/src/components/ChatView.tsx",
        commit: "aaaaaaa",
        subject: "feat: one",
        domain: "project-windows",
        class: "mechanical",
        resolution: "reapplied",
        decidedBy: "agent",
      },
      {
        path: "apps/web/src/quiet.ts",
        commit: "aaaaaaa",
        subject: "feat: one",
        domain: "project-windows",
        class: "mechanical",
        resolution: "reapplied",
        decidedBy: "agent",
      },
    ],
    decisions: [],
    censusFiles: [
      { path: "apps/web/src/components/ChatView.tsx", hunks: 2, commit: "aaaaaaa", domain: "x" },
    ],
  },
  {
    tag: "v0.0.39",
    before: "2222222",
    after: "3333333",
    recordUrl: "https://example.invalid/2",
    conflicts: [
      {
        path: "apps/web/src/components/ChatView.tsx",
        commit: "bbbbbbb",
        subject: "feat: two",
        domain: "project-windows",
        class: "seam-moved",
        resolution: "reapplied",
        decidedBy: "human",
      },
    ],
    decisions: [],
    censusFiles: [
      { path: "apps/web/src/components/ChatView.tsx", hunks: 1, commit: "bbbbbbb", domain: "x" },
    ],
  },
]);

const guardInput = (overrides: Partial<GuardInput> = {}): GuardInput => ({
  commits: [{ sha: "a".repeat(40), short: "aaaaaaa", domain: "project-windows" }],
  filesBySha: new Map(),
  patchesBySha: new Map(),
  upstreamFiles: new Set(),
  hotSeams: readHotSeams(churn),
  ...overrides,
});

it("keeps spawn target selection out of the timeline without guarding upstream presentation", () => {
  const sha = "a".repeat(40);
  const cases = [
    [
      "MessagesTimeline.tsx",
      '+import { resolveAgentSpawnOpenTarget } from "./AgentSpawnCta.logic";',
      true,
    ],
    ["MessagesTimeline.tsx", "+  resolveAgentSpawnOpenTarget,", true],
    ["MessagesTimeline.tsx", "+const openTarget = resolveAgentSpawnOpenTarget(input);", true],
    [
      "MessagesTimeline.tsx",
      "+onClick={() => onOpenAgents(openTarget.selectedAgentId, openTarget.rosterFocusAgentId)}",
      true,
    ],
    [
      "MessagesTimeline.tsx",
      '+import { createAgentSpawnOpenHandler } from "./AgentSpawnNavigation";',
      false,
    ],
    ["MessagesTimeline.tsx", "+const onOpenAgents = createAgentSpawnOpenHandler(input);", false],
    [
      "MessagesTimeline.tsx",
      "+onOpenAgents?: (agentId?: string | null, rosterFocusAgentId?: string | null) => void;",
      false,
    ],
    ["MessagesTimeline.tsx", '+<button type="button" onClick={onOpenAgents}>', false],
    [
      "MessagesTimeline.tsx",
      "+const status = live && livePhase ? livePhase.title : summary.status;",
      false,
    ],
    ["MessagesTimeline.tsx", "+// resolveAgentSpawnOpenTarget stays in the adapter.", false],
    ["MessagesTimeline.tsx", "-const openTarget = resolveAgentSpawnOpenTarget(input);", false],
    ["AgentSpawnNavigation.ts", "+const target = resolveAgentSpawnOpenTarget(input);", false],
    ["AgentSpawnCta.logic.ts", "+export function resolveAgentSpawnOpenTarget(input) {", false],
  ] as const;
  for (const [file, line, expected] of cases) {
    const path = `apps/web/src/components/chat/${file}`;
    const warnings = collectScanWarnings(
      guardInput({
        patchesBySha: parseCommitPatches(
          patch(sha, `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${line}`),
        ),
      }),
    );
    assert.strictEqual(
      warnings.some((warning) => warning.rule === "agent-spawn-navigation"),
      expected,
      `${file}: ${line}`,
    );
  }
});

it("keeps editor loading, surfaces and link normalization behind the rich Markdown boundaries", () => {
  const preview = "apps/web/src/components/files/FilePreviewPanel.tsx";
  const links = "apps/web/src/markdown-links.ts";
  const boundary = "apps/web/src/components/files/RichMarkdownPreviewBoundary.tsx";
  const editorLinks = "apps/web/src/components/files/richMarkdownEditorLinks.ts";
  const sha = "a".repeat(40);
  for (const [path, addition, expected] of [
    [preview, '+const editor = lazy(() => import("./MarkdownRichEditor"));', true],
    [preview, '+import { MarkdownRichEditor as Editor } from "./MarkdownRichEditor";', true],
    [preview, '+import { Editor } from "@milkdown/kit/core";', true],
    [preview, '+import {\n+  Editor,\n+} from "@milkdown/kit/core";', true],
    [preview, "+function RichMarkdownSurface(props) {", true],
    [preview, "+const RichMarkdownEditorSurface = (props) => {", true],
    [preview, "+return <RichMarkdownSurface {...props} />;", true],
    [links, "+function normalizeDotSegments(path: string): string {", true],
    [links, "+const normalizeDotSegments = (path) => path;", true],
    [
      preview,
      '+import { RichMarkdownPreviewBoundary } from "./RichMarkdownPreviewBoundary";',
      false,
    ],
    [preview, "+return <RichMarkdownPreviewBoundary {...props} />;", false],
    [preview, "+const mode = resolveRichMarkdownPreviewMode(input);", false],
    [preview, '+import { FileSaveCoordinator } from "./fileSaveCoordinator";', false],
    [links, "+const position = splitFilePathPosition(href);", false],
    [boundary, '+const editor = lazy(() => import("./MarkdownRichEditor"));', false],
    [boundary, "+function RichMarkdownEditorSurface(props) {", false],
    [editorLinks, "+function normalizeDotSegments(path) {", false],
    [links, "-function normalizeDotSegments(path) {", false],
    [preview, '+// import { Editor } from "@milkdown/kit/core";', false],
    [links, "+/* function normalizeDotSegments(path) {} */", false],
  ] as const) {
    const warnings = collectScanWarnings(
      guardInput({
        patchesBySha: parseCommitPatches(
          patch(sha, `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${addition}`),
        ),
      }),
    );
    assert.strictEqual(
      warnings.some((warning) => warning.rule === "rich-markdown-boundary"),
      expected,
      `${path}: ${addition}`,
    );
  }
});

it("keeps desktop preview window ownership and bridge capability behind WindowPolicy", () => {
  const preload = "apps/desktop/src/preload.ts";
  const ipc = "apps/desktop/src/ipc/methods/preview.ts";
  const manager = "apps/desktop/src/preview/Manager.ts";
  const policy = "apps/desktop/src/preview/WindowPolicy.ts";
  const policyPreload = "apps/desktop/src/preview/WindowPolicy.preload.ts";
  const sha = "a".repeat(40);
  for (const [path, addition, expected] of [
    [
      preload,
      "+  openProjectWindow: (projectRef) => ipcRenderer.invoke(CHANNEL, projectRef),",
      true,
    ],
    [preload, "+  projectWindowRef: readProjectWindowPreloadParts(process.argv),", true],
    [preload, "+  getWindowDemandState: () => windowDemandState,", true],
    [preload, "+  onWindowDemandStateChange: (listener) => {", true],
    [
      preload,
      "+ipcRenderer.on(IpcChannels.WINDOW_DEMAND_STATE_CHANNEL, (_event, demanded) => {",
      true,
    ],
    [
      preload,
      '+import { readProjectWindowPreloadParts } from "./window/projectWindowArgument.ts";',
      true,
    ],
    [ipc, "+  const senderWindow = BrowserWindow.fromWebContents(event.sender);", true],
    [ipc, "+  const identity = yield* electronWindow.identityFor(senderWindow);", true],
    [ipc, "+const resolvePreviewForSender = Effect.fn(name)(function* (event) {", true],
    [manager, "+export const makeWindowOwnership = Effect.fn(name)(function* (create) {", true],
    [manager, "+const scopedManager = (entry) => ({", true],
    [manager, "+  const authorizeTab = Effect.fn(name)(function* (entry, tabId) {", true],
    [manager, '+export const HUB_WINDOW_IDENTITY = { kind: "hub" };', true],
    [manager, "+export function windowIdentityKey(identity) {", true],
    // The narrow integration call and import stay valid in every upstream file.
    [
      preload,
      '+import { exposePreviewCapability } from "./preview/WindowPolicy.preload.ts";',
      false,
    ],
    [
      preload,
      '+contextBridge.exposeInMainWorld("desktopBridge", exposePreviewCapability(desktopBridge));',
      false,
    ],
    [
      ipc,
      "+  return yield* PreviewWindowPolicy.resolvePreviewForSender(event, window, manager, error);",
      false,
    ],
    [
      ipc,
      "+  yield* PreviewWindowPolicy.installEventForwarding(electronWindow, manager, channels);",
      false,
    ],
    [
      manager,
      "+  const ownership = yield* PreviewWindowPolicy.makeWindowOwnership(create, error);",
      false,
    ],
    [
      manager,
      "+    setMainWindow: (window) => ownership.setWindow(PreviewWindowPolicy.HUB_WINDOW_IDENTITY, window),",
      false,
    ],
    // The fork-owned boundary pair is where all of this belongs.
    [policyPreload, "+  getWindowDemandState: () => windowDemandState,", false],
    [policy, "+export const makeWindowOwnership = Effect.fn(name)(function* (create) {", false],
    [policy, "+  const senderWindow = BrowserWindow.fromWebContents(event.sender);", false],
    // Removals and comments never trigger an authoring warning.
    [preload, "-  getWindowDemandState: () => windowDemandState,", false],
    [manager, "+// export function windowIdentityKey(identity) {", false],
  ] as const) {
    const warnings = collectScanWarnings(
      guardInput({
        patchesBySha: parseCommitPatches(
          patch(sha, `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${addition}`),
        ),
      }),
    );
    assert.strictEqual(
      warnings.some((warning) => warning.rule === "desktop-preview-ownership"),
      expected,
      `${path}: ${addition}`,
    );
  }
});

it("guards provider agent implementations while allowing provider-specific siblings and calls", () => {
  const sha = "a".repeat(40);
  const layers = "apps/server/src/provider/Layers";
  const cases = [
    [
      `${layers}/ClaudeProvider.ts`,
      "+export function parseClaudeInitializationAgents(agents) {",
      true,
    ],
    [`${layers}/ClaudeProvider.ts`, "+export const withClaudeAgentOptions = (models) => {", true],
    [`${layers}/CodexProvider.ts`, "+export function withCodexAgentOptions(models) {", true],
    [
      "apps/server/src/provider/Drivers/CodexDriver.ts",
      "+const makeCodexAgentOptionsDecorator = (input) => Effect.gen(function* () {",
      true,
    ],
    [
      `${layers}/ClaudeAdapter.ts`,
      "+function claudeChildItemRenderDetail(tool, workspaceRoot) {",
      true,
    ],
    [`${layers}/ClaudeAdapter.ts`, "+const withClaudeAgentLaunchArgs = (configured) => {", true],
    [
      `${layers}/ClaudeAgentOptions.fork.ts`,
      "+export function withClaudeAgentOptions(models) {",
      false,
    ],
    [
      `${layers}/CodexAgentOptions.fork.ts`,
      "+export const makeCodexAgentOptionsDecorator = Effect.fn()(function* (input) {",
      false,
    ],
    [
      `${layers}/ClaudeChildItemDetail.fork.ts`,
      "+export function claudeChildItemRenderDetail(tool, workspaceRoot) {",
      false,
    ],
    [
      "apps/server/src/provider/Drivers/CodexDriver.ts",
      "+      const withCodexAgentSelection = yield* makeCodexAgentOptionsDecorator({",
      false,
    ],
    [
      `${layers}/ClaudeAdapter.ts`,
      '+import { claudeChildItemRenderDetail } from "./ClaudeChildItemDetail.fork.ts";',
      false,
    ],
    [
      `${layers}/ClaudeProvider.ts`,
      "+const models = withClaudeAgentOptions(baseModels, agents);",
      false,
    ],
    [
      `${layers}/CodexProvider.ts`,
      '+import { withCodexAgentOptions } from "./CodexAgentOptions.fork.ts";',
      false,
    ],
    [`${layers}/ClaudeProvider.ts`, "-export function withClaudeAgentOptions(models) {", false],
  ] as const;
  for (const [path, line, expected] of cases) {
    const warnings = collectScanWarnings(
      guardInput({
        patchesBySha: parseCommitPatches(
          patch(sha, `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${line}`),
        ),
      }),
    );
    assert.strictEqual(
      warnings.some((warning) => warning.rule === "provider-agent-boundary"),
      expected,
      `${path}: ${line}`,
    );
  }
});

it("rejects reintroduced physical sidebar derivation and permits the policy adapter", () => {
  const sha = "a".repeat(40);
  const cases = [
    [
      "apps/web/src/components/Sidebar.tsx",
      "+const forcedProjectGroup = useMemo(() => groups.find(match), [groups]);",
      true,
    ],
    [
      "apps/web/src/components/Sidebar.tsx",
      "+ref.environmentId === forcedProjectRef.environmentId",
      true,
    ],
    [
      "apps/web/src/components/LegacySidebar.tsx",
      "+project.id === forcedProjectRef?.projectId",
      true,
    ],
    [
      "apps/web/src/components/Sidebar.tsx",
      "+const scope = resolveSidebarPhysicalScope({ forcedProjectRef, projectGroups, logicalScopeKey });",
      false,
    ],
    [
      "apps/web/src/components/LegacySidebar.tsx",
      "+const projects = filterSidebarProjects(allProjects, forcedProjectRef);",
      false,
    ],
    [
      "apps/web/src/components/Sidebar.tsx",
      "-const forcedProjectGroup = useMemo(findGroup, [groups]);",
      false,
    ],
    [
      "apps/web/src/components/Sidebar.tsx",
      "+// forcedProjectRef.environmentId is matched by the adapter.",
      false,
    ],
    [
      "apps/web/src/components/sidebar/SidebarPhysicalScope.ts",
      "+ref.environmentId === forcedProjectRef.environmentId",
      false,
    ],
    // Re-declaring an upstream sidebar export to carry the ref is the shape that made every
    // upstream edit to those declarations conflict, in all four integration files.
    [
      "apps/web/src/components/Sidebar.tsx",
      "+export default function Sidebar({ forcedProjectRef = null }) {",
      true,
    ],
    [
      "apps/web/src/components/AppSidebarLayout.tsx",
      "+  forcedProjectRef?: ScopedProjectRef | null;",
      true,
    ],
    [
      "apps/web/src/components/AppSidebarLayout.tsx",
      "+          <ThreadSidebar forcedProjectRef={forcedProjectRef} />",
      true,
    ],
    [
      "apps/web/src/components/sidebar/SidebarChrome.tsx",
      "+  forcedProjectRef: ScopedProjectRef | null;",
      true,
    ],
    // The ambient read and the shorthand hand-off to SidebarPhysicalScope stay allowed.
    [
      "apps/web/src/components/Sidebar.tsx",
      "+  const forcedProjectRef = useSidebarPhysicalScope();",
      false,
    ],
    [
      "apps/web/src/components/LegacySidebar.tsx",
      "+    if (forcedProjectRef === null) return projects;",
      false,
    ],
    [
      "apps/web/src/components/Sidebar.tsx",
      "+  }, [clearSelection, forcedProjectRef, projectScopeKey]);",
      false,
    ],
    [
      "apps/web/src/components/sidebar/SidebarChrome.tsx",
      "+  const forcedProjectRef = useSidebarPhysicalScope();",
      false,
    ],
  ] as const;
  for (const [path, addition, forbidden] of cases) {
    const patchesBySha = parseCommitPatches(
      patch(sha, [`--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", addition].join("\n")),
    );
    const warnings = collectScanWarnings(
      guardInput({
        filesBySha: new Map([[sha, [path]]]),
        patchesBySha,
        upstreamFiles: new Set([path]),
      }),
    );
    assert.strictEqual(
      warnings.some((warning) => warning.rule === "sidebar-physical-scope"),
      forbidden,
      `${path}: ${addition}`,
    );
  }
});

it("guards direct thread navigation policy while preserving boundary calls and upstream params", () => {
  const sha = "a".repeat(40);
  const sources = [
    "components/ChatView.tsx",
    "components/CommandPalette.tsx",
    "hooks/useHandleNewThread.ts",
    "hooks/useThreadActions.ts",
  ];
  const cases = [
    ['+import { resolveThreadRouteFamily } from "../threadRoutes";', true],
    ['+import {\n+  resolveThreadRouteFamily as resolveFamily,\n+} from "../threadRoutes";', true],
    ["+select: (params) => resolveThreadRouteFamily(params),", true],
    ["+select: (params) => {\n+ return resolveThreadRouteFamily(params);\n+},", true],
    ["+function resolveThreadRouteFamily(params) {", true],
    ['+import { resolveThreadRouteFamily } from "../lib/threadRouteNavigation";', false],
    ['+import { resolveThreadRouteDeparture } from "../lib/threadRouteNavigation";', false],
    ['+import { resolveThreadRouteRef } from "../threadRoutes";', false],
    ["+...resolveThreadRouteDeparture(getCurrentRouteParams(), fallbackThreadRef),", false],
    ["+const family = useThreadRouteFamily();", false],
    ["+...resolveThreadRouteFamily(getCurrentRouteParams()).draft(draftId),", false],
    ["+const target = useParams({ strict: false, select: resolveThreadRouteTarget });", false],
    ["+// select: (params) => resolveThreadRouteFamily(params)", false],
    ['+/* import { resolveThreadRouteFamily } from "../threadRoutes"; */', false],
    ['-import { resolveThreadRouteFamily } from "../threadRoutes";', false],
  ] as const;
  for (const source of sources) {
    for (const [lines, expected] of cases) {
      const path = `apps/web/src/${source}`;
      const warnings = collectScanWarnings(
        guardInput({
          patchesBySha: parseCommitPatches(
            patch(sha, `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines}`),
          ),
        }),
      );
      assert.strictEqual(
        warnings.some((warning) => warning.rule === "thread-route-navigation"),
        expected,
        `${source}: ${lines}`,
      );
    }
  }
  const path = "apps/web/src/lib/threadRouteNavigation.ts";
  const warnings = collectScanWarnings(
    guardInput({
      patchesBySha: parseCommitPatches(
        patch(
          sha,
          `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+import { resolveThreadRouteFamily } from "../threadRoutes";`,
        ),
      ),
    }),
  );
  assert.deepStrictEqual(warnings, []);
});

it("keeps a path hot only while the ledger charged for it more than once", () => {
  const seams = readHotSeams(churn);
  assert.deepStrictEqual([...seams.keys()], ["apps/web/src/components/ChatView.tsx"]);
  assert.deepStrictEqual(seams.get("apps/web/src/components/ChatView.tsx"), {
    walkCount: 2,
    worstClass: "seam-moved",
    countUnit: "conflict walk(s)",
  });
});

it("warns about inline terminal retention and selection while allowing its fork-owned hook and upstream index", () => {
  const sha = "a".repeat(40);
  const make = (file: string, content: string) =>
    collectScanWarnings(
      guardInput({
        patchesBySha: parseCommitPatches(
          patch(
            sha,
            [`--- a/${file}`, `+++ b/${file}`, "@@ -1,0 +2,1 @@", `+${content}`].join("\n"),
          ),
        ),
      }),
    );
  for (const content of [
    "export interface RetainedTerminalAttachmentState {",
    "export function updateRetainedTerminalAttachment(",
    "const [committed, setCommitted] = useState(initial);",
    "useEffect(() => {",
    "const summary = metadata.data?.find((terminal) =>",
    "const match = summaries.find((summary) =>",
  ]) {
    const warnings = make("apps/web/src/state/terminalSessions.ts", content);
    assert.deepStrictEqual(
      warnings.map(({ rule }) => rule),
      ["terminal-attachment-boundary"],
    );
    assert.include(warnings[0]!.detail, "terminalAttachmentRetention.fork.ts");
  }
  assert.isEmpty(
    make("apps/web/src/state/terminalAttachmentRetention.fork.ts", "useEffect(() => {"),
  );
  assert.isEmpty(
    make(
      "apps/web/src/state/terminalSessions.ts",
      "const retained = useRetainedTerminalAttachment(input, attach);",
    ),
  );
  assert.isEmpty(
    make(
      "apps/web/src/state/terminalSessions.ts",
      "const summary = selectTerminalSummary(metadata.data, input.terminal);",
    ),
  );
  assert.isEmpty(
    make(
      "apps/web/src/state/terminalSessions.ts",
      "const metadataIndexes = new WeakMap<ReadonlyArray<TerminalSummary>, TerminalMetadataIndex>();",
    ),
  );
});

it("rejects handoff registration in the upstream settings registry and permits its extension", () => {
  const registry = "apps/web/src/components/settings/settingsSearch.ts";
  const extension = "apps/web/src/components/settings/githubIssueSettingsSearch.ts";
  const consumer = "apps/web/src/components/settings/useAvailableSettingsSearchItems.ts";
  for (const [file, content, rejected] of [
    [registry, '+  id: "github-issue-handoff-prompt",', true],
    [registry, "+  'id': 'github-issue-handoff-prompt',", true],
    [registry, '+  id: "upstream-setting",', false],
    [registry, '-  id: "github-issue-handoff-prompt",', false],
    [registry, '+// id: "github-issue-handoff-prompt" was moved.', false],
    [extension, '+  id: "github-issue-handoff-prompt",', false],
    [
      consumer,
      "+const items = filterAvailableGitHubIssueSettingsSearchItems(availability);",
      false,
    ],
    [registry, "+const items = filterAvailableSettingsSearchItems(availability);", false],
  ] as const) {
    const warnings = collectScanWarnings(
      guardInput({
        patchesBySha: parseCommitPatches(
          patch(
            "a".repeat(40),
            [`--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", content].join("\n"),
          ),
        ),
      }),
    );
    assert.strictEqual(
      warnings.some(({ rule }) => rule === "github-issue-settings-search"),
      rejected,
      `${file}: ${content}`,
    );
  }
});

it("rejects inline mobile ignored-file policy while permitting its helper and upstream route gates", () => {
  const route = "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx";
  const inspector = "apps/mobile/src/features/files/thread-file-navigator-pane.tsx";
  const helper = "apps/mobile/src/features/files/ignoredWorkspaceFileListing.ts";
  for (const [file, content, rejected] of [
    [route, "+const showIgnoredFiles = preferences.value.showIgnoredFiles === true;", true],
    [route, "+input: { cwd, includeIgnored: true },", true],
    [route, "+input: { cwd, includeIgnored: false },", true],
    [route, "+input: { cwd, includeIgnored },", true],
    [inspector, "+const showIgnoredFiles = preferences.value.showIgnoredFiles === true;", true],
    [inspector, "+input: { cwd: props.cwd, includeIgnored: true },", true],
    [inspector, "+input: { cwd: props.cwd, includeIgnored },", true],
    [route, "+const listing = useIgnoredWorkspaceFileListing(cwd);", false],
    [inspector, "+const workspaceFileListing = useIgnoredWorkspaceFileListing(props.cwd);", false],
    [
      route,
      "+environmentId !== null && workspaceFileListing !== null && !fileInspector.supported",
      false,
    ],
    [route, "+const preferences = useAtomValue(otherPreference);", false],
    [route, "+// includeIgnored belongs in the helper.", false],
    [route, "-const showIgnoredFiles = preferences.value.showIgnoredFiles;", false],
    [helper, "+return showIgnoredFiles ? { cwd, includeIgnored: true } : { cwd };", false],
    [
      "apps/mobile/src/features/settings/SettingsRouteScreen.tsx",
      "+const showIgnoredFiles = preferences.showIgnoredFiles;",
      false,
    ],
  ] as const) {
    const warnings = collectScanWarnings(
      guardInput({
        patchesBySha: parseCommitPatches(
          patch(
            "a".repeat(40),
            [`--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", content].join("\n"),
          ),
        ),
      }),
    );
    assert.strictEqual(
      warnings.some(({ rule }) => rule === "mobile-ignored-file-listing"),
      rejected,
      `${file}: ${content}`,
    );
  }
});

it("rejects the old pull-request scope policy while permitting upstream derivation and fork adapters", () => {
  const route = "apps/web/src/routes/_chat.pull-requests.tsx";
  const filters = "apps/web/src/components/pullRequest/PullRequestListFilters.tsx";
  const duplicate = "apps/web/src/components/pullRequest/pullRequestListRoute.ts";
  const scope = "apps/web/src/components/pullRequest/PullRequestProjectScope.ts";
  const shell = "apps/web/src/state/shell.ts";
  const sha = "a".repeat(40);
  for (const [file, content, rejected] of [
    [route, "+const forcedProjectScope = listScope.projectRef;", true],
    [route, "+const requested = forcedProjectScope?.environmentId ?? search.environmentId;", true],
    [route, "+const projectId = forcedProjectRef.projectId;", true],
    [filters, "+const options = projects === null ? [] : projects.map(toOption);", true],
    [duplicate, "+export function validatePullRequestsSearch(raw) { return raw; }", true],
    [
      route,
      '+import { validatePullRequestsSearch } from "../components/pullRequest/pullRequestListRoute";',
      true,
    ],
    [shell, "+export const environmentShellBootstrappedAtom = Atom.family(makeScopedAtom);", true],
    [route, "+const titleCounts = new Map<string, number>();", true],
    [
      route,
      "+      const canonical = project.repositoryIdentity?.canonicalKey?.toLowerCase();",
      true,
    ],
    [route, "+function distinguishTitles(projects, suffix) { return projects; }", true],
    [route, "+    const scopedProjects = pullRequestFilterProjects(projects, labels);", false],
    [route, "+    baselineQuery.refresh();", true],
    [route, "+    authoredQuery.refresh();", true],
    [route, "+    reviewingQuery.refresh();", true],
    [route, "+    facetQuery.refresh();", true],
    [filters, "+const titleCounts = new Map<string, number>();", true],
    [filters, "+function distinguishTitles(projects, suffix) { return projects; }", true],
    [filters, "+function scopedRefreshList(includeRelated) { refreshList(includeRelated); }", true],
    [filters, "+    baselineQuery.refresh();", true],
    [route, "+const projectScope = usePullRequestProjectScope(input);", false],
    [route, "+const patch = normalizePullRequestProjectScopePatch(next, forcedProjectRef);", false],
    [
      route,
      "+    () => pullRequestFilterProjects(projects, environmentLabels, scopedProject),",
      false,
    ],
    [route, "+  const refreshList = (includeRelated = false) => {", false],
    [route, "+  const refreshFromHost = async (includeDetail = true) => {", false],
    [route, "+    refreshList(true);", false],
    [route, "+      listQuery.refresh([...listTargets, ...related]);", false],
    [
      route,
      "+      statsQuery.refresh(batches.map(({ environmentId, input }) => ({ environmentId, input })));",
      false,
    ],
    [
      route,
      "+        arrived.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),",
      false,
    ],
    [filters, "+const options = projects.toSorted(compare).map(toOption);", false],
    [filters, "+showProjectFilter?: boolean;", false],
    [scope, "+const forcedProjectScope = listScope.projectRef;", false],
    [
      "apps/web/src/state/windowProjectBootstrap.fork.ts",
      "+export const environmentShellBootstrappedAtom = Atom.family(makeScopedAtom);",
      false,
    ],
    [shell, "+export const allEnvironmentShellsBootstrappedAtom = Atom.make(readAll);", false],
    [route, "-const forcedProjectScope = listScope.projectRef;", false],
    [filters, "+// projects === null was the old scope signal.", false],
    [duplicate, "+/* Retired search adapter. */", false],
    [route, "+const environments = capableEnvironments.filter(matchesSearch);", false],
  ] as const) {
    const warnings = collectScanWarnings(
      guardInput({
        patchesBySha: parseCommitPatches(
          patch(sha, [`--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", content].join("\n")),
        ),
      }),
    );
    assert.strictEqual(
      warnings.some((warning) => warning.rule === "pull-request-project-scope"),
      rejected,
      `${file}: ${content}`,
    );
  }
});

it("warns when a fork commit touches a hot seam and stays quiet on a cold upstream file", () => {
  const hot = collectScanWarnings(
    guardInput({
      filesBySha: new Map([
        ["a".repeat(40), ["apps/web/src/components/ChatView.tsx", "apps/web/src/quiet.ts"]],
      ]),
      upstreamFiles: new Set(["apps/web/src/components/ChatView.tsx", "apps/web/src/quiet.ts"]),
    }),
  );
  assert.deepStrictEqual(
    hot.map(({ rule, commit, domain }) => `${rule} ${commit} ${domain}`),
    ["hot-seam aaaaaaa project-windows"],
  );
  assert.include(hot[0]?.detail ?? "", "2 conflict walk(s), seam-moved");

  const forkOwned = collectScanWarnings(
    guardInput({
      filesBySha: new Map([["a".repeat(40), ["apps/web/src/components/ChatView.tsx"]]]),
      upstreamFiles: new Set(),
    }),
  );
  assert.deepStrictEqual(forkOwned, []);
});

it("warns when a fork test block lands in an upstream test file, not in its fork sibling", () => {
  const patches = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        "--- a/apps/web/src/threadRoutes.test.ts",
        "+++ b/apps/web/src/threadRoutes.test.ts",
        "@@ -10,0 +11,2 @@",
        '+it("routes a project thread", () => {',
        "+});",
        "--- a/apps/web/src/threadRoutes.fork.test.ts",
        "+++ b/apps/web/src/threadRoutes.fork.test.ts",
        "@@ -1,0 +2,1 @@",
        '+it("routes a fork thread", () => {});',
        "",
      ].join("\n"),
    ),
  );
  const warnings = collectScanWarnings(
    guardInput({
      patchesBySha: patches,
      upstreamFiles: new Set([
        "apps/web/src/threadRoutes.test.ts",
        "apps/web/src/threadRoutes.fork.test.ts",
      ]),
    }),
  );
  assert.deepStrictEqual(
    warnings.map(({ rule, detail }) => `${rule} ${detail}`),
    [
      "upstream-test apps/web/src/threadRoutes.test.ts gains 1 fork test block(s); move them to apps/web/src/threadRoutes.fork.test.ts",
    ],
  );
  assert.strictEqual(
    forkTestSibling("apps/web/src/ChatView.logic.test.tsx"),
    "apps/web/src/ChatView.logic.fork.test.tsx",
  );
});

it("defers only the two proven file-local integration harnesses", () => {
  const deferred = [...UPSTREAM_TEST_FILE_LOCAL_HARNESS_DEFERRALS];
  const patches = parseCommitPatches(
    patch(
      "a".repeat(40),
      deferred
        .map(
          (path) => `--- a/${path}\n+++ b/${path}\n@@ -10,0 +11,1 @@\n+it("fork case", () => {});`,
        )
        .join("\n"),
    ),
  );
  assert.deepStrictEqual(deferred, [
    "apps/desktop/src/window/DesktopWindow.test.ts",
    "apps/server/src/server.test.ts",
  ]);
  assert.deepStrictEqual(
    collectScanWarnings(
      guardInput({
        patchesBySha: patches,
        upstreamFiles: new Set(deferred),
      }),
    ),
    [],
  );
});

it("counts Effect aliases and follows target ownership for independent test additions", () => {
  const path = "apps/web/src/state/terminalSessions.test.ts";
  const patchesBySha = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        "--- /dev/null",
        `+++ b/${path}`,
        "@@ -0,0 +1,2 @@",
        '+effectIt.effect("retains a fork attachment", () => Effect.void);',
        '+it.effect("supports direct Effect tests", () => Effect.void);',
      ].join("\n"),
    ),
  );
  const input = guardInput({ patchesBySha, upstreamFiles: new Set() });
  assert.deepStrictEqual(collectScanWarnings(input), []);
  const warnings = collectScanWarnings({ ...input, upstreamTestFiles: new Set([path]) });
  assert.lengthOf(warnings, 1);
  assert.include(warnings[0]!.detail, "gains 2 fork test block(s)");
  assert.deepStrictEqual(
    collectScanWarnings({
      ...input,
      upstreamFiles: new Set([path]),
      upstreamTestFiles: new Set(),
    }),
    [],
  );
});

it("flags a renamed test title in a slice file as a fork reintroduction", () => {
  const path = "apps/server/src/orchestration/Layers/CheckpointReactor.test.ts";
  const patches = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -718 +733 @@ describe(",
        '-  it("does not adopt a drifted checkout when the worktree is shared by another thread", async () => {',
        '+  it("adopts drift for idle branch-bound threads sharing the worktree", async () => {',
        "",
      ].join("\n"),
    ),
  );
  assert.deepStrictEqual(
    collectScanWarnings(
      guardInput({
        patchesBySha: patches,
        upstreamFiles: new Set([path]),
      }),
    ).map(({ rule, detail }) => `${rule} ${detail}`),
    [
      `upstream-test ${path} changes or removes 1 upstream test line(s) (first: it("does not adopt a drifted checkout when the worktree is shared by another thread", async () => {); a fork commit may only append to an upstream test file, so move the changed case to ${forkTestSibling(path)} and restore the upstream one`,
      `upstream-test ${path} renames 1 test title(s); move the fork case to ${forkTestSibling(path)} and restore the upstream title`,
    ],
  );
});

it("refuses a renamed upstream test whose removed and added openers share a hunk", () => {
  const path = "apps/web/src/threadRoutes.test.ts";
  const patches = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -10,3 +10,3 @@",
        '-it("routes a hub thread", () => {',
        '-  assert.strictEqual(route, "/thread");',
        '+it("routes a project thread", () => {',
        '+  assert.strictEqual(route, "/project/thread");',
        "",
      ].join("\n"),
    ),
  );
  assert.deepStrictEqual(
    collectScanWarnings(
      guardInput({
        patchesBySha: patches,
        upstreamFiles: new Set([path]),
      }),
    ).map(({ rule, detail }) => `${rule} ${detail}`),
    [
      `upstream-test ${path} changes or removes 2 upstream test line(s) (first: it("routes a hub thread", () => {); a fork commit may only append to an upstream test file, so move the changed case to ${forkTestSibling(path)} and restore the upstream one`,
    ],
  );
});

it("accepts an append-only fork commit and the repair that takes the fork's own lines back out", () => {
  const path = "apps/web/src/threadRoutes.test.ts";
  const upstreamTestLines = new Map([
    [
      path,
      significantTestLines(
        'it("routes a hub thread", () => {\n  assert.strictEqual(route, "/thread");\n});\n',
      ),
    ],
  ]);
  const appended = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -12,0 +13,2 @@",
        '+  assert.strictEqual(route.window, "hub");',
        "+",
        "",
      ].join("\n"),
    ),
  );
  assert.deepStrictEqual(
    collectScanWarnings(
      guardInput({
        patchesBySha: appended,
        upstreamFiles: new Set([path]),
        upstreamTestLines,
      }),
    ),
    [],
  );
  // The repair the rule asks for deletes a line too — the fork's own.
  const repaired = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -13 +12,0 @@",
        '-  assert.strictEqual(route.window, "hub");',
        "",
      ].join("\n"),
    ),
  );
  assert.deepStrictEqual(
    collectScanWarnings(
      guardInput({
        patchesBySha: repaired,
        upstreamFiles: new Set([path]),
        upstreamTestLines,
      }),
    ),
    [],
  );
});

it("leaves an upstream test file the divergence sweep already lists to its recorded debt", () => {
  const path = "apps/web/src/localApi.test.ts";
  const patches = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -20 +19,0 @@",
        "-  expect(showContextMenu).toHaveBeenCalledWith(items, undefined);",
        "",
      ].join("\n"),
    ),
  );
  const input = {
    patchesBySha: patches,
    upstreamFiles: new Set([path]),
  };
  assert.lengthOf(collectScanWarnings(guardInput(input)), 1);
  assert.deepStrictEqual(
    collectScanWarnings(guardInput({ ...input, upstreamTestDebt: new Set([path]) })),
    [],
  );
});

it("refuses a same-size rewrite of an upstream assertion under an unchanged title", () => {
  const path = "apps/web/src/threadRoutes.test.ts";
  const patches = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -10,3 +10,3 @@",
        '-it("routes a hub thread", () => {',
        '-  assert.strictEqual(route, "/thread");',
        '+it("routes a hub thread", () => {',
        '+  assert.strictEqual(route, "/project/thread");',
        "",
      ].join("\n"),
    ),
  );
  assert.deepStrictEqual(
    collectScanWarnings(
      guardInput({
        patchesBySha: patches,
        upstreamFiles: new Set([path]),
      }),
    ).map(({ rule, detail }) => `${rule} ${detail}`),
    [
      `upstream-test ${path} changes or removes 2 upstream test line(s) (first: it("routes a hub thread", () => {); a fork commit may only append to an upstream test file, so move the changed case to ${forkTestSibling(path)} and restore the upstream one`,
    ],
  );
});

it("warns when an unrelated test is deleted in one hunk and another is appended elsewhere", () => {
  const path = "apps/web/src/threadRoutes.test.ts";
  const patches = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -10,2 +10,0 @@",
        '-it("drops an obsolete upstream case", () => {});',
        "-",
        "@@ -50,0 +49,2 @@",
        '+it("adds a fork-only case", () => {});',
        "+",
        "",
      ].join("\n"),
    ),
  );
  assert.deepStrictEqual(
    collectScanWarnings(
      guardInput({
        patchesBySha: patches,
        upstreamFiles: new Set([path]),
      }),
    ).map(({ rule, detail }) => `${rule} ${detail}`),
    [
      `upstream-test ${path} gains 1 fork test block(s); move them to ${forkTestSibling(path)}`,
      `upstream-test ${path} changes or removes 1 upstream test line(s) (first: it("drops an obsolete upstream case", () => {});); a fork commit may only append to an upstream test file, so move the changed case to ${forkTestSibling(path)} and restore the upstream one`,
    ],
  );
});

it("warns when one commit spreads over more upstream files than the budget", () => {
  const upstream = Array.from(
    { length: UPSTREAM_FOOTPRINT_BUDGET + 1 },
    (_, index) => `apps/web/src/upstream${index}.ts`,
  );
  const overBudget = collectScanWarnings(
    guardInput({
      filesBySha: new Map([["a".repeat(40), [...upstream, "apps/web/src/forkOnly.ts"]]]),
      upstreamFiles: new Set(upstream),
    }),
  );
  assert.deepStrictEqual(
    overBudget.map(({ rule }) => rule),
    ["footprint"],
  );
  assert.include(overBudget[0]?.detail ?? "", `${UPSTREAM_FOOTPRINT_BUDGET + 1} upstream file(s)`);

  const atBudget = collectScanWarnings(
    guardInput({
      filesBySha: new Map([["a".repeat(40), upstream.slice(1)]]),
      upstreamFiles: new Set(upstream),
    }),
  );
  assert.deepStrictEqual(atBudget, []);
});

it("warns when a commit deletes an upstream export and re-declares it elsewhere", () => {
  const patches = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        "--- a/apps/web/src/routes/_chat.pull-requests.tsx",
        "+++ b/apps/web/src/routes/_chat.pull-requests.tsx",
        "@@ -1,3 +1,0 @@",
        "-export interface PullRequestsSearch {",
        "-  readonly state: string;",
        "-}",
        "--- /dev/null",
        "+++ b/apps/web/src/components/pullRequest/pullRequestListRoute.ts",
        "@@ -0,0 +1,3 @@",
        "+export interface PullRequestsSearch {",
        "+  readonly state: string;",
        "+}",
        "",
      ].join("\n"),
    ),
  );
  const warnings = collectScanWarnings(
    guardInput({
      patchesBySha: patches,
      upstreamFiles: new Set(["apps/web/src/routes/_chat.pull-requests.tsx"]),
    }),
  );
  assert.deepStrictEqual(
    warnings.map(({ rule }) => rule),
    ["replaced-export", "pull-request-project-scope"],
  );
  assert.include(warnings[0]?.detail ?? "", "interface PullRequestsSearch is deleted from");
  assert.include(warnings[0]?.detail ?? "", "pullRequestListRoute.ts");
});

it("leaves a purely additive commit alone", () => {
  const patches = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        "--- a/apps/web/src/routes/_chat.pull-requests.tsx",
        "+++ b/apps/web/src/routes/_chat.pull-requests.tsx",
        "@@ -4,0 +5,1 @@",
        "+export const PULL_REQUEST_LIST_SORTS = [] as const;",
        "",
      ].join("\n"),
    ),
  );
  assert.deepStrictEqual(
    collectScanWarnings(
      guardInput({
        patchesBySha: patches,
        upstreamFiles: new Set(["apps/web/src/routes/_chat.pull-requests.tsx"]),
      }),
    ),
    [],
  );
});

it("warns on a lockfile change in any domain and leaves source-only commits alone", () => {
  const locked = collectScanWarnings(
    guardInput({
      filesBySha: new Map([
        ["a".repeat(40), ["pnpm-lock.yaml", "apps/web/src/quiet.ts", "native/relay/Cargo.lock"]],
      ]),
      upstreamFiles: new Set(["pnpm-lock.yaml", "apps/web/src/quiet.ts"]),
    }),
  );
  assert.deepStrictEqual(
    locked.map(({ rule, detail }) => `${rule} ${detail.split(" ")[0]}`),
    ["lockfile native/relay/Cargo.lock", "lockfile pnpm-lock.yaml"],
  );
  assert.include(locked[1]?.detail ?? "", "in a project-windows commit");

  const sourceOnly = collectScanWarnings(
    guardInput({
      filesBySha: new Map([["a".repeat(40), ["apps/web/src/quiet.ts", "apps/web/package.json"]]]),
      upstreamFiles: new Set(["apps/web/src/quiet.ts", "apps/web/package.json"]),
    }),
  );
  assert.deepStrictEqual(sourceOnly, []);
});

it("reads one patch record per commit and asks Git for zero-context hunks", () => {
  const patches = parseCommitPatches(
    `${patch("a".repeat(40), "--- a/one.ts\n+++ b/one.ts\n+export const one = 1;\n")}${patch(
      "b".repeat(40),
      "--- a/two.ts\n+++ b/two.ts\n-export const two = 2;\n",
    )}`,
  );
  assert.deepStrictEqual([...patches.keys()], ["a".repeat(40), "b".repeat(40)]);
  assert.deepStrictEqual(patches.get("a".repeat(40))?.addedExports, [
    { path: "one.ts", kind: "const", name: "one" },
  ]);
  assert.deepStrictEqual(patches.get("b".repeat(40))?.removedExports, [
    { path: "two.ts", kind: "const", name: "two" },
  ]);
  assert.include(commitPatchArguments(["aaa"]), "--unified=0");
});

it("renders warnings under one counted heading and nothing when there are none", () => {
  assert.deepStrictEqual(renderScanWarnings([]), []);
  const lines = renderScanWarnings([
    { rule: "footprint", commit: "aaaaaaa", domain: "project-windows", detail: "9 upstream" },
    { rule: "hot-seam", commit: "bbbbbbb", domain: "custom-agents", detail: "ChatView.tsx" },
  ]);
  assert.strictEqual(lines[1], "Ledger guards, 2 warning(s) (hot-seam: 1, footprint: 1):");
  assert.strictEqual(lines[2], "  WARN  footprint  aaaaaaa  project-windows  9 upstream");
});
