import { assert, it } from "@effect/vitest";

import {
  collectScanWarnings,
  commitPatchArguments,
  forkTestSibling,
  parseCommitPatches,
  readHotSeams,
  renderScanWarnings,
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

it("guards provider agent implementations while allowing provider-specific siblings and calls", () => {
  const sha = "a".repeat(40);
  const cases = [
    ["ClaudeProvider.ts", "+export function parseClaudeInitializationAgents(agents) {", true],
    ["ClaudeProvider.ts", "+export const withClaudeAgentOptions = (models) => {", true],
    ["CodexProvider.ts", "+export function withCodexAgentOptions(models) {", true],
    ["ClaudeAgentOptions.fork.ts", "+export function withClaudeAgentOptions(models) {", false],
    ["CodexAgentOptions.fork.ts", "+export function withCodexAgentOptions(models) {", false],
    ["ClaudeProvider.ts", "+const models = withClaudeAgentOptions(baseModels, agents);", false],
    [
      "CodexProvider.ts",
      '+import { withCodexAgentOptions } from "./CodexAgentOptions.fork.ts";',
      false,
    ],
    ["ClaudeProvider.ts", "-export function withClaudeAgentOptions(models) {", false],
  ] as const;
  for (const [file, line, expected] of cases) {
    const path = `apps/server/src/provider/Layers/${file}`;
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
      `${file}: ${line}`,
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

it("keeps a path hot only while the ledger charged for it more than once", () => {
  const seams = readHotSeams(churn);
  assert.deepStrictEqual([...seams.keys()], ["apps/web/src/components/ChatView.tsx"]);
  assert.deepStrictEqual(seams.get("apps/web/src/components/ChatView.tsx"), {
    walkCount: 2,
    worstClass: "seam-moved",
  });
});

it("warns about inline terminal retention while allowing its fork-owned hook and upstream index", () => {
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
      "const metadataIndexes = new WeakMap<ReadonlyArray<TerminalSummary>, TerminalMetadataIndex>();",
    ),
  );
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
  assert.include(hot[0]?.detail ?? "", "2 walk(s), worst class seam-moved");

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

it("leaves a renamed upstream test alone when its removed and added openers share a hunk", () => {
  const patches = parseCommitPatches(
    patch(
      "a".repeat(40),
      [
        "--- a/apps/web/src/threadRoutes.test.ts",
        "+++ b/apps/web/src/threadRoutes.test.ts",
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
        upstreamFiles: new Set(["apps/web/src/threadRoutes.test.ts"]),
      }),
    ),
    [],
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
    [`upstream-test ${path} gains 1 fork test block(s); move them to ${forkTestSibling(path)}`],
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
    ["replaced-export"],
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
