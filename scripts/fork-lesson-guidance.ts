// @effect-diagnostics nodeBuiltinImport:off - Read-only Git evidence for standalone authoring scans.
import { parseLedger, hotSeams, type ChurnEntry } from "./fork-churn-ledger.ts";
import { requireSeamRecords, type SeamRecord } from "./lib/fork-churn-seams.ts";
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
}

/** Read-only projection: outcome records in v3 belong to outcome accounting, never this writer. */
export const readLessonEvidence = (raw: string): LessonEvidence => {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return { walks: parseLedger(raw), seamRecords: [] };
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid lesson ledger");
  const value = parsed as Record<string, unknown>;
  if (value.version !== 2 && value.version !== 3)
    throw new Error("unsupported lesson ledger version");
  return {
    walks: parseLedger(JSON.stringify(value.walks)),
    seamRecords: requireSeamRecords(value.seamRecords),
  };
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
  if (/\.test\.tsx?$/.test(path))
    return {
      boundary:
        "new fork-specific test cases only: use a fork-owned *.fork.test.ts(x) sibling and preserve target-tree upstream tests",
      owner: 448,
    };
  return undefined;
};

export const lessonInventory = (evidence: LessonEvidence) => {
  const paths = new Map<
    string,
    { original: boolean; observations: Set<string>; repairs: Set<string> }
  >();
  const add = (path: string, observation?: string) => {
    const row = paths.get(path) ?? {
      original: false,
      observations: new Set<string>(),
      repairs: new Set<string>(),
    };
    if (observation) row.observations.add(observation);
    paths.set(path, row);
    return row;
  };
  for (const path of ORIGINAL_LESSON_PATHS) add(path).original = true;
  for (const walk of evidence.walks) {
    for (const file of walk.censusFiles) add(file.path, walk.tag);
    for (const file of walk.conflicts) add(file.path, walk.tag);
  }
  for (const record of evidence.seamRecords) {
    if (record.kind === "observation") for (const file of record.files) add(file.path, record.id);
    if (record.kind === "repair") {
      const before = evidence.seamRecords.find((row) => row.id === record.before.observation);
      if (before?.kind === "observation") {
        const file = before.files[record.before.row];
        if (file) add(file.path).repairs.add(record.guard);
      }
    }
  }
  return [...paths]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([path, evidence]) => ({
      path,
      original: evidence.original,
      observations: evidence.observations.size,
      guards: [...evidence.repairs],
      preferred: preferredLessonBoundary(path),
    }));
};

export const lessonHotSeams = (evidence: LessonEvidence) => {
  const seams = new Map(
    hotSeams(evidence.walks).map((row) => [
      row.path,
      { walkCount: row.walkCount, worstClass: row.worstClass as string },
    ]),
  );
  const observed = new Map<string, number>();
  for (const record of evidence.seamRecords)
    if (record.kind === "observation") {
      for (const path of new Set(record.files.map((file) => file.path)))
        observed.set(path, (observed.get(path) ?? 0) + 1);
    }
  for (const [path, count] of observed)
    if (!seams.has(path))
      seams.set(path, { walkCount: count, worstClass: "retained census observation" });
  return seams;
};

export const renderLessonGuidance = (source: LessonSource, evidence: LessonEvidence): string => {
  const rows = lessonInventory(evidence);
  return [
    `Lesson evidence: ${source.ref} at ${source.sha ?? "unknown"}; freshness=${source.freshness}; origin=${source.remoteSha ?? "unknown"}`,
    `  ${source.detail}`,
    `Lesson inventory: ${rows.length} paths; ${rows.filter((row) => row.original).length} original paths retained. Presence, absence and named guards do not prove repair.`,
    ...rows.map(
      (row) =>
        `  ${row.path} [${row.original ? "original scope; " : ""}${row.observations} retained observation(s)] -> ${row.preferred ? `${row.preferred.boundary} (owner ${row.preferred.owner})` : "unresolved: no reviewed preferred boundary; retain this lesson for owner review"}${row.guards.length ? `; recorded guards: ${row.guards.join(", ")}` : "; no repair guard attested"}`,
    ),
    "",
  ].join("\n");
};
