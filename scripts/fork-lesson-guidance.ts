// @effect-diagnostics nodeBuiltinImport:off - Read-only Git evidence for standalone authoring scans.
import { parseLedger, parseChurnState, hotSeams, type ChurnEntry } from "./fork-churn-ledger.ts";
import {
  assessSeams,
  freezeObservation,
  seamRecord,
  requireSeamRecords,
  type CensusSnapshot,
  type SeamAssessment,
  type SeamRecord,
} from "./lib/fork-churn-seams.ts";
import { CHURN_LEDGER_FILE, requireBotRef } from "./lib/fork-bot-refs.ts";
import { runCommand, type CommandResult } from "./lib/fork-command.ts";

/** Preserve the complete original per-file inventory, including the five original hot seams. */
export const ORIGINAL_LESSON_PATHS = [
  "apps/web/src/components/ChatView.tsx",
  "apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts",
  "apps/web/src/components/ChatView.logic.test.ts",
  "apps/web/src/components/files/FileBrowserPanel.tsx",
  "apps/web/src/routes/_chat.pull-requests.tsx",
  "apps/desktop/src/settings/DesktopClientSettings.test.ts",
  "apps/mobile/src/features/settings/SettingsRouteScreen.tsx",
  "apps/mobile/src/persistence/mobile-preferences.ts",
  "apps/server/src/git/GitManager.test.ts",
  "apps/server/src/git/GitManager.ts",
  "apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts",
  "apps/server/src/server.ts",
  "apps/web/src/components/BranchToolbarEnvModeSelector.tsx",
  "apps/web/src/components/ChatMarkdown.tsx",
  "apps/web/src/components/CommandPalette.tsx",
  "apps/web/src/components/pullRequest/PullRequestListFilters.tsx",
  "apps/web/src/components/settings/settingsSearch.test.ts",
  "apps/web/src/components/settings/settingsSearch.ts",
  "apps/web/src/components/Sidebar.tsx",
  "apps/web/src/hooks/useNowMinute.ts",
  "packages/contracts/src/settings.test.ts",
  "pnpm-lock.yaml",
  "t3.json",
] as const;

export interface LessonEvidence {
  readonly walks: ReadonlyArray<ChurnEntry>;
  readonly seamRecords: ReadonlyArray<SeamRecord>;
  readonly notices?: ReadonlyArray<string>;
}

/** Validate known envelopes before projecting; future schemas remain explicitly partial. */
export const readLessonEvidence = (raw: string): LessonEvidence => {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return { walks: parseLedger(raw), seamRecords: [] };
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid lesson ledger");
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 2
  )
    throw new Error("unsupported lesson ledger version");
  if (value.version > 3) {
    const notices = [
      `Lesson schema v${value.version} is newer than this reader; only compatible known fields are projected, never complete schema support.`,
    ];
    let walks: ReadonlyArray<ChurnEntry> = [];
    let seamRecords: ReadonlyArray<SeamRecord> = [];
    try {
      walks = parseLedger(JSON.stringify(value.walks));
    } catch {
      notices.push(
        "Walk fields are incompatible; original inventory remains visible but current walk guidance is unavailable.",
      );
    }
    try {
      seamRecords = requireSeamRecords(value.seamRecords);
    } catch {
      notices.push(
        "Seam fields are incompatible; repair assessment is unavailable, never verified by omission.",
      );
    }
    return { walks, seamRecords, notices };
  }
  const state = parseChurnState(raw);
  return { walks: state.walks, seamRecords: state.seamRecords };
};

export interface LessonSource {
  readonly ref: string;
  readonly sha: string | null;
  readonly remoteSha: string | null;
  readonly freshness: "current" | "stale" | "offline" | "unavailable";
  readonly detail: string;
  readonly raw: string | null;
}
type LessonGit = (args: ReadonlyArray<string>) => CommandResult;
const commitSha = (result: CommandResult): string | null =>
  result.status === 0 && /^[a-f0-9]{40}$/.test(result.stdout.trim()) ? result.stdout.trim() : null;

/** Fetch objects only: authoring reads must never overwrite a bot-owned or ordinary branch ref. */
export const resolveLessonSource = (
  root: string,
  ref: string,
  offline: boolean,
  run?: LessonGit,
): LessonSource => {
  requireBotRef(ref);
  const git =
    run ??
    ((args) =>
      runCommand("git", args, {
        cwd: root,
        timeout: 15_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }));
  const localSha = commitSha(git(["rev-parse", "--verify", `${ref}^{commit}`]));
  const read = (sha: string | null) => {
    if (sha === null) return null;
    const result = git(["show", `${sha}:${CHURN_LEDGER_FILE}`]);
    return result.status === 0 ? result.stdout : null;
  };
  const localRaw = read(localSha);
  const cached = (
    freshness: LessonSource["freshness"],
    detail: string,
    remoteSha: string | null = null,
  ): LessonSource => ({ ref, sha: localSha, remoteSha, freshness, detail, raw: localRaw });
  if (offline) return cached("offline", "explicit --offline; remote freshness was not checked");
  const advertised = () => {
    const result = git(["ls-remote", "--exit-code", "origin", ref]);
    const match =
      result.status === 0
        ? result.stdout
            .trim()
            .split("\n")
            .find((line) => line.split("\t")[1] === ref)
            ?.split("\t")[0]
        : undefined;
    return { status: result.status, sha: match && /^[a-f0-9]{40}$/.test(match) ? match : null };
  };
  const before = advertised();
  if (before.sha === null)
    return cached(
      before.status === 2 ? "unavailable" : "offline",
      before.status === 2
        ? "declared ref is absent on origin; retained local evidence is not current"
        : "origin could not be checked; retained evidence freshness is unknown",
    );
  let raw = read(before.sha);
  if (raw === null) {
    const fetched = git([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "origin",
      before.sha,
    ]);
    if (fetched.status !== 0)
      return cached(
        "stale",
        "origin advertises a different lesson commit but its objects could not be fetched",
        before.sha,
      );
    raw = read(before.sha);
  }
  const after = advertised();
  if (raw === null)
    return cached(
      "unavailable",
      "published lesson commit does not contain the declared ledger file",
      before.sha,
    );
  return {
    ref,
    sha: before.sha,
    remoteSha: after.sha,
    freshness: after.sha === before.sha ? "current" : after.sha === null ? "offline" : "stale",
    detail:
      after.sha === before.sha
        ? "origin matched before and after the immutable read"
        : after.sha === null
          ? "origin could not be rechecked after the immutable read"
          : "origin moved during the read; rerun for its newer lesson inventory",
    raw,
  };
};

// These owners cover the stated policy, not every fork change in a shared file.
// Keep integration paths exact; an unfamiliar basename does not inherit a reviewed boundary.
const boundaries: ReadonlyArray<{
  readonly paths: ReadonlyArray<string>;
  readonly boundary: string;
  readonly owner: number;
}> = [
  {
    paths: [
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/components/CommandPalette.tsx",
      "apps/web/src/hooks/useHandleNewThread.ts",
    ],
    boundary:
      "thread-route navigation only: apps/web/src/lib/threadRouteNavigation.ts; resolve route params at execution time; other ChatView policy remains unresolved here",
    owner: 446,
  },
  {
    paths: [
      "apps/desktop/src/preview/Manager.ts",
      "apps/desktop/src/ipc/methods/preview.ts",
      "apps/desktop/src/preload.ts",
    ],
    boundary:
      "desktop preview window ownership and sender authorization only: apps/desktop/src/preview/WindowPolicy.ts and WindowPolicy.preload.ts; leave upstream browser-profile behavior with upstream",
    owner: 524,
  },
  {
    paths: [
      "apps/web/src/components/Sidebar.tsx",
      "apps/web/src/components/LegacySidebar.tsx",
      "apps/web/src/components/AppSidebarLayout.tsx",
    ],
    boundary:
      "physical project scope only: apps/web/src/components/sidebar/SidebarPhysicalScope.ts; preserve upstream filtering, grouping and row presentation; adjacent manual ordering remains a separate policy",
    owner: 584,
  },
  {
    paths: ["apps/web/src/state/terminalSessions.ts"],
    boundary:
      "apps/web/src/state/terminalAttachmentRetention.fork.ts; retain upstream metadata/index ownership",
    owner: 582,
  },
  {
    paths: ["apps/server/src/provider/Layers/ClaudeProvider.ts"],
    boundary:
      "Claude SDK agent normalization and model selection metadata only: apps/server/src/provider/Layers/ClaudeAgentOptions.fork.ts; startup/resume, child-work results, identity and launcher environment joins require their own scoped review",
    owner: 583,
  },
  {
    paths: ["apps/server/src/provider/Drivers/CodexDriver.ts"],
    boundary:
      "Codex discovered-agent model selection metadata only: apps/server/src/provider/Layers/CodexAgentOptions.fork.ts; startup/resume, child-work results, identity and launcher environment joins require their own scoped review",
    owner: 583,
  },
  {
    paths: ["apps/server/src/provider/Layers/CodexProvider.ts"],
    boundary:
      "agent model metadata additions only: keep helper declarations out of CodexProvider; compose apps/server/src/provider/Layers/CodexAgentOptions.fork.ts at the CodexDriver snapshot boundary; runtime and child-work policy remains unresolved here",
    owner: 583,
  },
  {
    paths: [
      "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
      "apps/mobile/src/features/files/thread-file-navigator-pane.tsx",
    ],
    boundary:
      "apps/mobile/src/features/files/ignoredWorkspaceFileListing.ts; keep connection and query gates",
    owner: 536,
  },
  {
    paths: ["apps/web/src/components/chat/MessagesTimeline.tsx"],
    boundary:
      "apps/web/src/components/chat/AgentSpawnNavigation.ts; preserve agent child navigation",
    owner: 537,
  },
  {
    paths: ["apps/web/src/components/files/FilePreviewPanel.tsx", "apps/web/src/markdown-links.ts"],
    boundary:
      "rich Markdown editing only: apps/web/src/components/files/RichMarkdownPreviewBoundary.tsx and richMarkdownEditorLinks.ts; keep the existing file-save path",
    owner: 538,
  },
  {
    paths: ["apps/web/src/components/settings/settingsSearch.ts"],
    boundary:
      "apps/web/src/components/settings/githubIssueSettingsSearch.ts; compose availability outside the upstream registry",
    owner: 539,
  },
  {
    paths: [
      "apps/web/src/routes/_chat.pull-requests.tsx",
      "apps/web/src/components/pullRequest/PullRequestListFilters.tsx",
    ],
    boundary: "apps/web/src/components/pullRequest/PullRequestProjectScope.ts",
    owner: 535,
  },
  {
    paths: ["apps/web/src/state/shell.ts"],
    boundary:
      "physical project-window bootstrap only: apps/web/src/state/windowProjectBootstrap.fork.ts; retain upstream shell orchestration",
    owner: 535,
  },
  {
    paths: ["apps/web/src/components/pullRequest/pullRequestListRoute.ts"],
    boundary:
      "retired parser path: keep the upstream route validator and apply physical scope through apps/web/src/components/pullRequest/PullRequestProjectScope.ts; do not recreate this route parser",
    owner: 535,
  },
  {
    paths: [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      ".github/workflows/hyprws-ci.yml",
      ".github/workflows/hyprws-release.yml",
    ],
    boundary:
      ".github/fork-workflow-reviews.json; inspect counterpart changes and record adaptation or justified no-change",
    owner: 573,
  },
  {
    paths: ["pnpm-lock.yaml"],
    boundary:
      "package manifest intent plus the pinned lockfile generator; never hand-merge generated dependency state",
    owner: 312,
  },
];

export const preferredLessonBoundary = (path: string) => {
  const scoped = boundaries.find((entry) => entry.paths.includes(path));
  if (scoped) return scoped;
  if (path === "apps/web/src/state/terminalSessions.test.ts")
    return {
      boundary:
        "terminal indexing and attachment coverage: preserve upstream metadata tests and use terminalAttachmentRetention.fork.test.ts for fork retention behavior",
      owner: 582,
    };
  if (
    path === "apps/desktop/src/window/DesktopWindow.test.ts" ||
    path === "apps/server/src/server.test.ts"
  )
    return {
      boundary:
        "exact file-local harness deferral: retain the documented integration cases here; do not import the upstream test module into a sibling",
      owner: 448,
    };
  if (UPSTREAM_TEST_LESSON_PATHS.has(path))
    return {
      boundary:
        "new fork-specific test cases only: use a fork-owned *.fork.test.ts(x) sibling and preserve target-tree upstream tests",
      owner: 448,
    };
  return undefined;
};

const UPSTREAM_TEST_LESSON_PATHS = new Set([
  "apps/web/src/components/ChatView.logic.test.ts",
  "apps/desktop/src/settings/DesktopClientSettings.test.ts",
  "apps/server/src/git/GitManager.test.ts",
  "apps/web/src/components/settings/settingsSearch.test.ts",
  "packages/contracts/src/settings.test.ts",
  "apps/desktop/src/preview/Manager.test.ts",
  "apps/desktop/src/updates/DesktopUpdates.test.ts",
  "apps/server/src/provider/Layers/ProviderService.test.ts",
  "apps/server/src/provider/Layers/ClaudeAdapter.test.ts",
  "apps/web/src/composerDraftStore.test.ts",
  "apps/server/src/pullRequest/GitHubPullRequestCli.test.ts",
  "apps/web/src/components/ThreadTerminalDrawer.test.ts",
]);

const walkSnapshot = (walk: ChurnEntry): CensusSnapshot => ({
  tag: walk.tag,
  fixedAt: walk.after,
  files: walk.censusFiles,
  ...(walk.censusEvidence === undefined ? {} : { censusEvidence: walk.censusEvidence }),
});

/** Shared content identities anchor two ordered histories; neither history outranks the other. */
const orderedLessonObservations = (evidence: LessonEvidence) => {
  const observations = new Map<string, CensusSnapshot>();
  const frozen: string[] = [];
  const completed: string[] = [];
  for (const record of evidence.seamRecords)
    if (record.kind === "observation") {
      frozen.push(record.id);
      observations.set(record.id, {
        tag: record.tag,
        fixedAt: null,
        files: record.files,
        ...(record.evidence === null ? {} : { censusEvidence: record.evidence }),
      });
    }
  for (const walk of evidence.walks) {
    const snapshot = walkSnapshot(walk);
    const id = seamRecord(freezeObservation(snapshot)).id;
    completed.push(id);
    observations.set(id, snapshot);
  }
  const successors = new Map([...observations.keys()].map((id) => [id, new Set<string>()]));
  const predecessors = new Map([...observations.keys()].map((id) => [id, 0]));
  for (const history of [frozen, completed]) {
    for (let index = 1; index < history.length; index++) {
      const previous = history[index - 1]!;
      const current = history[index]!;
      if (previous === current || successors.get(previous)!.has(current)) continue;
      successors.get(previous)!.add(current);
      predecessors.set(current, predecessors.get(current)! + 1);
    }
  }
  const ordered = new Map<string, CensusSnapshot>();
  const ready = [...predecessors].filter(([, count]) => count === 0).map(([id]) => id);
  let ambiguous = false;
  while (ready.length > 0) {
    if (ready.length > 1) ambiguous = true;
    const id = ready.shift()!;
    ordered.set(id, observations.get(id)!);
    for (const next of successors.get(id)!) {
      const remaining = predecessors.get(next)! - 1;
      predecessors.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  const unavailable =
    ordered.size !== observations.size
      ? "retained walk and frozen observation chronology is inconsistent"
      : ambiguous
        ? "retained walk and frozen observation chronology is ambiguous; a shared ordering anchor is required"
        : null;
  return { observations: unavailable === null ? ordered : observations, unavailable };
};

export const lessonObservations = (evidence: LessonEvidence): ReadonlyMap<string, CensusSnapshot> =>
  orderedLessonObservations(evidence).observations;

/** A published policy pass requires complete, ordered evidence from a verified current source. */
export const lessonAssessmentUnavailable = (
  evidence: LessonEvidence,
  source?: LessonSource,
): string | null => {
  if (source !== undefined && source.freshness !== "current")
    return `lesson source freshness is ${source.freshness}; retained evidence does not establish current policy`;
  if (evidence.notices !== undefined) return "newer schema is only partially understood";
  const { observations, unavailable } = orderedLessonObservations(evidence);
  if (unavailable !== null) return unavailable;
  return [...observations.values()].every((snapshot) =>
    snapshot.files.every((file) => file.subject !== undefined),
  )
    ? null
    : "retained census subjects need enrichment";
};

export const lessonInventory = (evidence: LessonEvidence) => {
  const paths = new Map<
    string,
    { original: boolean; observations: Set<string>; assessments: Array<SeamAssessment> }
  >();
  const add = (path: string, observation?: string) => {
    const row = paths.get(path) ?? {
      original: false,
      observations: new Set<string>(),
      assessments: [],
    };
    if (observation) row.observations.add(observation);
    paths.set(path, row);
    return row;
  };
  for (const path of ORIGINAL_LESSON_PATHS) add(path).original = true;
  const observations = lessonObservations(evidence);
  for (const walk of evidence.walks) {
    const id = seamRecord(freezeObservation(walkSnapshot(walk))).id;
    for (const file of walk.conflicts) add(file.path, id);
  }
  for (const [id, observation] of observations)
    for (const file of observation.files) add(file.path, id);
  const snapshots = [...observations.values()];
  const unavailable = lessonAssessmentUnavailable(evidence);
  const assessments = unavailable === null ? assessSeams(snapshots, evidence.seamRecords) : [];
  for (const assessment of assessments) add(assessment.path).assessments.push(assessment);
  return [...paths]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([path, row]) => ({
      path,
      original: row.original,
      observations: row.observations.size,
      assessments: row.assessments,
      assessmentUnavailable: unavailable,
      preferred: preferredLessonBoundary(path),
    }));
};

export const lessonHotSeams = (evidence: LessonEvidence) => {
  const seams = new Map(
    hotSeams(evidence.walks).map((row) => [
      row.path,
      {
        walkCount: row.walkCount,
        worstClass: row.worstClass as string,
        countUnit: "conflict walk(s)",
      },
    ]),
  );
  const observed = new Map<string, number>();
  for (const record of lessonObservations(evidence).values()) {
    for (const path of new Set(record.files.map((file) => file.path)))
      observed.set(path, (observed.get(path) ?? 0) + 1);
  }
  for (const [path, count] of observed)
    if (count > 1 && !seams.has(path))
      seams.set(path, {
        walkCount: count,
        worstClass: "repeated retained census observation",
        countUnit: "census observation(s)",
      });
  return seams;
};

export const renderLessonSource = (source: LessonSource, evidence: LessonEvidence): string =>
  [
    `Lesson evidence: ${source.ref} at ${source.sha ?? "unknown"}; freshness=${source.freshness}; origin=${source.remoteSha ?? "unknown"}`,
    `  ${source.detail}`,
    ...(evidence.notices ?? []).map((notice) => `  ${notice}`),
  ].join("\n");

export const renderLessonGuidance = (source: LessonSource, evidence: LessonEvidence): string => {
  const rows = lessonInventory(evidence);
  return [
    renderLessonSource(source, evidence),
    `Lesson inventory: ${rows.length} paths; ${rows.filter((row) => row.original).length} original paths retained. Presence, absence and named guards do not prove repair.`,
    "Policy references include closed historical issues; they identify reviewed scope, not a live assignment or current issue status.",
    ...rows.map(
      (row) =>
        `  ${row.path} [${row.original ? "original scope; " : ""}${row.observations} retained observation(s)] -> ${row.preferred ? `${row.preferred.boundary} (policy reference #${row.preferred.owner}; issue status is not inferred)` : "unresolved: no reviewed preferred boundary; retain this lesson for review"}${row.assessmentUnavailable ? `; assessment unavailable: ${row.assessmentUnavailable}` : row.assessments.length ? `; evidence: ${row.assessments.map((assessment) => `${assessment.status}${assessment.guard ? `, guard ${assessment.guard}` : ""}: ${assessment.reason}`).join(" | ")}` : "; no repair assessment available"}`,
    ),
    "",
  ].join("\n");
};
