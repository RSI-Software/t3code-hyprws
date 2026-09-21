import type { ResolutionStage } from "./fork-conflict-resolution.ts";
import type { ForkRebaseFeasibility } from "./fork-rebase-feasibility.ts";

// Rebase conflict handling: blocked-rebase issues and RSI bot resolution.

export type RebaseMode = "off" | "candidate" | "on";

export interface StableCandidate {
  readonly tag: string;
  readonly branch: string;
  readonly sha: string;
  readonly title: string;
  readonly marker: string;
  readonly label: "release";
  readonly body: string;
}

export interface RebaseStopCensus {
  readonly targetTag: string;
  /** Absent on legacy count-only censuses; their feasibility table is not stop evidence. */
  readonly evidence?: SequentialCensusEvidence;
  readonly conflictingForkCommitCount: number;
  readonly conflictingFileCount: number;
  readonly truncated: boolean;
  readonly truncatedBy: "stop-limit" | "time-limit" | null;
  readonly stopLimit: number;
  readonly timeLimitSeconds: number;
}

/**
 * How a census produced its rows. `sequential-rebase-stage3-provisional` is the measure before
 * RSI-Software/t3code-hyprws#1007: it counted every conflicted path, because it resolved each one
 * provisionally from stage 3 without asking the walk's resolver first. `sequential-rebase-walk-resolution`
 * runs the walk's own resolution sequence per path, so its rows say which stage owned each one.
 */
export type CensusMethod =
  | "sequential-rebase-stage3-provisional"
  | "sequential-rebase-walk-resolution";

/**
 * The stage that owned a conflicted path, in the walk's vocabulary. `hook-reapply-unverified` is a
 * census-only value: a rehearsal worktree has no installed modules, so the census skips the scoped
 * typecheck the walk runs on a re-insertion and says so rather than claiming a checked resolution.
 * `unmeasured` is a row from a `sequential-rebase-stage3-provisional` census, which recorded none.
 */
export type CensusStage = ResolutionStage | "hook-reapply-unverified" | "unmeasured";

const CENSUS_STAGES: ReadonlySet<string> = new Set<CensusStage>([
  "rerere",
  "upstream-only",
  "fork-only",
  "keep-both",
  "hook-reapply",
  "hook-reapply-unverified",
  "unresolved",
  "unmeasured",
]);

/**
 * What the fork side of a conflicted path *is*, judged at the replayed commit rather than at the
 * tip. The ledger recorded resolution effort and never structure, so it could not say whether a
 * recurring conflict was a seam a guard could retire or a hook that merely moved
 * (RSI-Software/t3code-hyprws#1101).
 *
 * - `hooked` — every fork-added line at that commit sits inside a marked hook the manifest knows.
 * - `woven` — fork lines are interleaved with upstream code outside any marked hook.
 * - `addition` — the path is fork-owned; there is no upstream side to weave into.
 *
 * `unclassified` is not a value: a v1 row recorded no shape and reads through `censusRowShape`.
 */
export type CensusShape = "hooked" | "woven" | "addition";

const CENSUS_SHAPES: ReadonlySet<string> = new Set<CensusShape>(["hooked", "woven", "addition"]);

/** The stored payload version. v2 adds per-row `shape` and `hooks`; v1 carries neither. */
export type CensusVersion = 1 | 2;

export interface SequentialCensusEvidence {
  readonly version: CensusVersion;
  readonly method: CensusMethod;
  readonly sourceSha: string;
  readonly baseSha: string;
  readonly targetSha: string;
  readonly targetTag: string;
  readonly complete: boolean;
  readonly rows: ReadonlyArray<{
    /** One-based stop ordinal, shared by all unmerged paths observed at that stop. */
    readonly stop: number;
    readonly commit: string;
    readonly subject: string;
    readonly domain: string | null;
    readonly path: string;
    readonly kind: "add/add" | "modify/delete" | "content" | "other-unmerged";
    /**
     * Which stage of the walk's resolution sequence owned this path. Absent on a row written
     * before the census ran that sequence; read it through `censusRowStage`, never directly. The
     * parser must not materialise it, because a stored seam record is re-digested from its parsed
     * payload and a field the stored JSON never carried would move every historical id.
     */
    readonly stage?: CensusStage;
    /**
     * Why the walk's resolution sequence left this path to a human, on an `unresolved` row only.
     * Absent on every other row and on one written before the census recorded it; read it through
     * `censusRowReason`, never directly. Like `stage`, the parser must not materialise it, because
     * a stored seam record is re-digested from its parsed payload. For the same reason the text
     * itself is the executor's deterministic `reason` and never its captured `detail`: a compiler
     * message or a worktree path here would mint a different record id for the same seam on every
     * machine (RSI-Software/t3code-hyprws#1012).
     */
    readonly reason?: string;
    /**
     * What the fork side of this path is at the replayed commit. Present on a `version: 2` row and
     * absent on every v1 one; read it through `censusRowShape`, never directly. The parser must not
     * materialise it, for the digest reason `stage` carries above.
     */
    readonly shape?: CensusShape;
    /**
     * The `<domain>/<name>` manifest keys whose marked hooks hold every fork-added line here.
     * Present only on a `shape: "hooked"` row, where it is non-empty and sorted, and absent on
     * every other row. It is the identity a hooked seam is keyed on, so a seam survives the path
     * move or subject rewrite that used to mint a fresh record.
     */
    readonly hooks?: ReadonlyArray<string>;
  }>;
}

/** A row that predates the resolution stages recorded none; its observation measures a conflict only. */
export const censusRowStage = (row: SequentialCensusEvidence["rows"][number]): CensusStage =>
  row.stage ?? "unmeasured";

/** A v1 row recorded no structure; only a v2 census judged shape at the replayed commit. */
export const censusRowShape = (
  row: SequentialCensusEvidence["rows"][number],
): CensusShape | "unclassified" => row.shape ?? "unclassified";

/** The manifest keys this row is seam-keyed on, empty on a row that is not hooked. */
export const censusRowHooks = (
  row: SequentialCensusEvidence["rows"][number],
): ReadonlyArray<string> => row.hooks ?? [];

/** What the walk recorded against this stop, or `null` on a row that carries no reason. */
export const censusRowReason = (row: SequentialCensusEvidence["rows"][number]): string | null =>
  row.reason ?? null;

export const censusTotals = (rows: SequentialCensusEvidence["rows"]) => ({
  conflictingForkCommitCount: new Set(rows.map((row) => row.commit)).size,
  conflictingFileCount: rows.length,
});

/**
 * What the conflict totals never said: how much of the walk an operator actually sees. The totals
 * above stay the conflict count, because forecast and churn measure seam pressure with them; this
 * splits the same rows by the stage that owned them (RSI-Software/t3code-hyprws#1007).
 *
 * The three counts are separate on purpose. `unverifiedFileCount` is a hook re-apply the census
 * placed but never typechecked, so it belongs to neither side: the optimistic human total is
 * `humanFileCount`, the pessimistic one is `humanFileCount + unverifiedFileCount`, and a reader
 * must be able to compute both.
 */
export const censusResolutionSplit = (rows: SequentialCensusEvidence["rows"]) => {
  const human = rows.filter((row) => censusRowStage(row) === "unresolved");
  const unverified = rows.filter((row) => censusRowStage(row) === "hook-reapply-unverified");
  const unmeasured = rows.filter((row) => censusRowStage(row) === "unmeasured");
  return {
    mechanicalFileCount: rows.length - human.length - unverified.length - unmeasured.length,
    unverifiedFileCount: unverified.length,
    humanFileCount: human.length,
    unmeasuredFileCount: unmeasured.length,
    humanForkCommitCount: new Set(human.map((row) => row.commit)).size,
    humanStopCount: new Set(human.map((row) => row.stop)).size,
  };
};

/**
 * The same rows split by what the fork side *is* rather than by what resolving it cost. A v1
 * census contributes only to `unclassifiedFileCount`, so a reader can tell an absent measurement
 * from a measured zero.
 */
export const censusShapeSplit = (rows: SequentialCensusEvidence["rows"]) => {
  const count = (shape: CensusShape | "unclassified") =>
    rows.filter((row) => censusRowShape(row) === shape).length;
  return {
    hookedFileCount: count("hooked"),
    wovenFileCount: count("woven"),
    additionFileCount: count("addition"),
    unclassifiedFileCount: count("unclassified"),
  };
};

/**
 * Per-domain carry cost: how much of each domain's conflict pressure a guard could retire, and how
 * much is woven into upstream code and therefore recurs every walk
 * (RSI-Software/t3code-hyprws#443). The ledger recorded resolution effort and never structure, so
 * this was unmeasurable until a v2 census judged shape.
 *
 * `recurring` counts distinct woven paths, not rows: the same path conflicting at four stops is one
 * seam an operator carries, not four. A domain whose rows are all unclassified reports
 * `measured: false`, so an absent measurement never reads as a domain with no carry cost.
 */
export const censusCarryCost = (rows: SequentialCensusEvidence["rows"]) => {
  const domains = new Map<string, SequentialCensusEvidence["rows"][number][]>();
  for (const row of rows) {
    const key = row.domain ?? "?";
    const owned = domains.get(key);
    if (owned === undefined) domains.set(key, [row]);
    else owned.push(row);
  }
  return [...domains]
    .map(([domain, owned]) => {
      const shaped = owned.filter((row) => censusRowShape(row) !== "unclassified");
      const paths = (shape: CensusShape) =>
        new Set(owned.filter((row) => censusRowShape(row) === shape).map((row) => row.path)).size;
      return {
        domain,
        measured: shaped.length > 0,
        recurring: paths("woven"),
        retirable: paths("hooked"),
        owned: paths("addition"),
        conflictFileCount: owned.length,
        forkCommitCount: new Set(owned.map((row) => row.commit)).size,
      };
    })
    .sort(
      (left, right) => right.recurring - left.recurring || left.domain.localeCompare(right.domain),
    );
};

/**
 * The marker retains exact paths and provenance independently of Markdown escaping. Both stored
 * versions parse: a v1 marker is still the only record of every census written before the shape
 * fields existed, and re-digesting one must keep yielding its historical seam ids.
 */
export const parseSequentialCensusEvidence = (body: string): SequentialCensusEvidence | null => {
  const marker = /<!-- sequential-census-v[12]:(.*?) -->/.exec(body)?.[1];
  if (marker === undefined) return null;
  return requireSequentialCensusEvidence(JSON.parse(marker));
};

/**
 * The shape fields are version-gated in both directions. A v1 payload carrying them would be a
 * v2 row mislabelled, and its seam ids would not match the v1 ones already stored against it; a v2
 * row missing `shape` would read as `unclassified` and silently drop out of the carry-cost count
 * the version exists to produce.
 */
const requireRowShape = (version: CensusVersion, row: Record<string, unknown>) => {
  if (version === 1) {
    if (row.shape !== undefined || row.hooks !== undefined)
      throw new Error("census v1 row carries v2 shape fields");
    return;
  }
  if (typeof row.shape !== "string" || !CENSUS_SHAPES.has(row.shape))
    throw new Error("census v2 row records no shape");
  if (row.shape !== "hooked") {
    if (row.hooks !== undefined) throw new Error("census hooks on an unhooked row");
    return;
  }
  if (
    !Array.isArray(row.hooks) ||
    row.hooks.length === 0 ||
    row.hooks.some((hook) => typeof hook !== "string")
  )
    throw new Error("census hooked row names no hook");
  const sorted = [...(row.hooks as string[])].toSorted();
  if (row.hooks.some((hook, index) => hook !== sorted[index]))
    throw new Error("census hooks are not sorted");
  if (new Set(row.hooks).size !== row.hooks.length) throw new Error("census hooks repeat a key");
};

export const requireSequentialCensusEvidence = (value: unknown): SequentialCensusEvidence => {
  if (typeof value !== "object" || value === null) throw new Error("invalid census evidence");
  const evidence = value as Record<string, unknown>;
  const sha = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
  if (
    (evidence.version !== 1 && evidence.version !== 2) ||
    (evidence.method !== "sequential-rebase-stage3-provisional" &&
      evidence.method !== "sequential-rebase-walk-resolution") ||
    !sha(evidence.sourceSha) ||
    !sha(evidence.baseSha) ||
    !sha(evidence.targetSha) ||
    typeof evidence.targetTag !== "string" ||
    typeof evidence.complete !== "boolean" ||
    !Array.isArray(evidence.rows)
  )
    throw new Error("invalid census provenance");
  const version = evidence.version as CensusVersion;
  const stops = new Map<number, string>();
  const pathsAtStops = new Set<string>();
  const rows = evidence.rows.map((item: unknown): SequentialCensusEvidence["rows"][number] => {
    if (typeof item !== "object" || item === null) throw new Error("invalid census stop row");
    const row = item as Record<string, unknown>;
    if (
      typeof row.stop !== "number" ||
      !Number.isSafeInteger(row.stop) ||
      row.stop < 1 ||
      !sha(row.commit) ||
      typeof row.subject !== "string" ||
      typeof row.path !== "string" ||
      (row.domain !== null && typeof row.domain !== "string") ||
      (row.kind !== "add/add" &&
        row.kind !== "modify/delete" &&
        row.kind !== "content" &&
        row.kind !== "other-unmerged") ||
      (row.stage !== undefined && !CENSUS_STAGES.has(row.stage as string)) ||
      (row.reason !== undefined && typeof row.reason !== "string")
    )
      throw new Error("invalid census stop row");
    requireRowShape(version, row);
    const priorCommit = stops.get(row.stop);
    const identity = `${row.stop}\u0000${row.path}`;
    if ((priorCommit !== undefined && priorCommit !== row.commit) || pathsAtStops.has(identity)) {
      throw new Error("inconsistent census stop identity");
    }
    stops.set(row.stop, row.commit);
    pathsAtStops.add(identity);
    return {
      stop: row.stop,
      commit: row.commit,
      subject: row.subject,
      domain: row.domain,
      path: row.path,
      kind: row.kind,
      ...(row.stage === undefined ? {} : { stage: row.stage as CensusStage }),
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      ...(row.shape === undefined ? {} : { shape: row.shape as CensusShape }),
      ...(row.hooks === undefined ? {} : { hooks: row.hooks as ReadonlyArray<string> }),
    };
  });
  return {
    version,
    method: evidence.method as CensusMethod,
    sourceSha: evidence.sourceSha,
    baseSha: evidence.baseSha,
    targetSha: evidence.targetSha,
    targetTag: evidence.targetTag,
    complete: evidence.complete,
    rows,
  };
};

export interface BlockedIssue {
  readonly title: string;
  readonly label: "rebase-blocked";
  readonly blockingSha: string;
  readonly blockingShortSha: string;
  readonly subject: string;
  readonly remainingUpstreamCount: number;
  readonly newestUpstreamTagBeyondWindow: string | null;
  readonly stopCensus: RebaseStopCensus | null;
  readonly stopCensusUnavailableReason: string | null;
  readonly conflicts: ReadonlyArray<{
    readonly path: string;
    readonly hunks: number;
    readonly forkCommit: string;
    readonly forkCommitShort: string;
    readonly forkSubject: string;
    readonly domain: string | null;
  }>;
  readonly body: string;
}

export const inlineCode = (value: string): string => {
  let delimiter = "`";
  while (value.includes(delimiter)) delimiter += "`";
  return `${delimiter}${value}${delimiter}`;
};

export const blockedIssueTitle = (tag: string, blockingShortSha: string): string =>
  `🔔 hyprws auto-rebase blocked at ${tag} (upstream ${blockingShortSha})`;

export const closeComment = (trunkSha: string | null): string =>
  trunkSha === null ? "Resolved: no longer conflicts." : `Resolved by hyprws ${trunkSha}.`;

/** Which lane crossed the stable upstream tag and published its snapshot. */
export type StableCandidateLane = "bot" | "unblock-apply";

const stableCandidateOrigin = (lane: StableCandidateLane): string =>
  lane === "bot" ? "The auto-rebase bot" : "The unblock apply lane";

export const stableCandidateBody = (
  tag: string,
  branch: string,
  mode: RebaseMode,
  lane: StableCandidateLane = "bot",
): string => `${stableCandidateOrigin(lane)} created \`${branch}\` from the fork stack rebased onto \`${tag}\`.
${
  mode === "candidate"
    ? "\nCandidate mode created this snapshot from a stack the trunk has not adopted. If that candidate is rejected, the create-only snapshot is hand-fix-only; the bot will not overwrite it.\n"
    : ""
}${
  lane === "unblock-apply"
    ? `\nThe apply that crossed \`${tag}\` landed the fork on a later upstream tag, so this snapshot is the same fork series on the older base. Its replay was checked for shape only; \`stable-prepare\` runs the full verification below.\n`
    : ""
}
Cut this stable fork release from this issue. Load the [\`fork-sync\`](https://github.com/RSI-Software/t3code-hyprws/blob/hyprws/.agents/skills/fork-sync/SKILL.md) skill and take its **cut stable** entry point:

\`\`\`bash
vp run fork:sync stable-list
vp run fork:sync stable-prepare --report <report> --issue <this issue>
vp run fork:sync stable-publish --report <report> --go <exact-candidate>
\`\`\`

Every step stops for a human decision, and \`stable-prepare\` renders the UAT draft. [Cut a stable release](https://github.com/RSI-Software/t3code-hyprws/blob/hyprws/docs/fork/operations/fork-sync.md#cut-a-stable-release) owns the verification and the release record.

<!-- hyprws-stable-candidate: ${tag}-hyprws -->`;

interface BlockedPlan {
  readonly oldSha?: string;
  readonly baseSha?: string;
  readonly horizon?: { readonly sha: string } | null;
  readonly target: { readonly tag: string } | null;
  readonly newestTagBeyondWindow: { readonly tag: string } | null;
  readonly feasibility: ForkRebaseFeasibility;
}

/**
 * The forecast side of the blocked table (RSI-Software/t3code-hyprws#1143): one row's
 * `upstream/main state`, plus the conflict rows only `origin/main` saw. `fork-forecast.ts`
 * owns both joins and this module never imports it, so a forecast failure never stops
 * the block from being published.
 */
export interface ForecastJoin {
  readonly stateOf: (row: { readonly commit: string; readonly path: string }) => string;
  readonly mainOnly: ReadonlyArray<{
    readonly commit: string;
    readonly subject: string;
    readonly domain: string;
    readonly path: string;
  }>;
}

const NO_FORECAST: ForecastJoin = { stateOf: () => "unknown (unavailable)", mainOnly: [] };

export const buildBlockedIssue = (
  plan: BlockedPlan,
  stopCensus: RebaseStopCensus | null = null,
  stopCensusUnavailableReason: string | null = null,
  forecastJoin: ForecastJoin = NO_FORECAST,
): BlockedIssue | null => {
  if (stopCensus?.evidence !== undefined) {
    stopCensus = { ...stopCensus, ...censusTotals(stopCensus.evidence.rows) };
  }
  const first = plan.feasibility.ffBoundary.firstConflict;
  const horizon = plan.newestTagBeyondWindow;
  if (first === null || horizon === null) return null;
  const conflicts = plan.feasibility.conflicts.map((conflict) => ({
    path: conflict.path,
    hunks: conflict.hunkCount,
    forkCommit: conflict.introducingForkCommit.sha,
    forkCommitShort: conflict.introducingForkCommit.shortSha,
    forkSubject: conflict.introducingForkCommit.subject,
    domain: conflict.introducingForkCommit.domain,
  }));
  const remaining =
    plan.feasibility.ffBoundary.upstreamCommitCount - plan.feasibility.ffBoundary.cleanCommitCount;
  const evidence = stopCensus?.evidence;
  const totals = stopCensus;
  const cell = (value: string) => inlineCode(value.replaceAll("\\", "\\\\").replaceAll("|", "\\|"));
  const body = [
    plan.target === null
      ? "The fork stack has no newer clean upstream tag to advance to."
      : `The fork stack advances to ${inlineCode(plan.target.tag)}, the newest clean upstream tag.`,
    `${remaining} upstream ${remaining === 1 ? "commit sits" : "commits sit"} behind the blocking commit ${inlineCode(first.sha)}.`,
    "",
    `Blocking upstream commit: ${inlineCode(`${first.sha} ${first.subject}`)}`,
    `Newest upstream tag beyond the clean window: ${plan.newestTagBeyondWindow === null ? "none" : `\`${plan.newestTagBeyondWindow.tag}\``}`,
    "",
    "## Sequential rebase census",
    "",
    stopCensusUnavailableReason !== null && stopCensus === null
      ? `The sequential rebase census was unavailable: ${inlineCode(stopCensusUnavailableReason)}.`
      : stopCensus === null
        ? "No upstream release tag exists beyond this block, so there is no tagged rebase target to rehearse."
        : `A throwaway rebase rehearsal to ${inlineCode(stopCensus.targetTag)} found ${totals!.conflictingForkCommitCount} conflicting fork ${totals!.conflictingForkCommitCount === 1 ? "commit" : "commits"} and ${totals!.conflictingFileCount} conflict-file ${totals!.conflictingFileCount === 1 ? "observation" : "observations"}. Repeated paths count at each stop.`,
    ...(evidence === undefined
      ? ["Legacy count-only sequential measurement: stop rows and replay SHAs were not retained."]
      : [
          `Source: ${inlineCode(evidence.sourceSha)}; base: ${inlineCode(evidence.baseSha)}; target: ${inlineCode(evidence.targetSha)}. ${evidence.complete ? "Complete" : "Partial"} observation set.`,
          "",
          `The ${inlineCode("upstream/main state")} column replays the same fork commit against live ${inlineCode("origin/main")}: ${inlineCode("conflict")}, ${inlineCode("not observed")}, or ${inlineCode("unknown (<reason>)")} when the forecast cannot answer. It selects nothing and applies nothing.`,
          "",
          `| Stop | File | Conflict kind | Stage |${evidence.version === 1 ? "" : " Shape |"} Replayed fork commit | Domain | tagged replay state | upstream/main state |`,
          `| ---: | --- | --- | --- |${evidence.version === 1 ? "" : " --- |"} --- | --- | --- | --- |`,
          ...evidence.rows.map(
            (row) =>
              `| ${row.stop} | ${cell(row.path)} | ${row.kind} | ${censusRowStage(row)} |${evidence.version === 1 ? "" : ` ${censusRowShape(row)}${row.hooks === undefined ? "" : ` ${row.hooks.map(cell).join(" ")}`} |`} ${cell(`${row.commit} ${row.subject}`)} | ${cell(row.domain ?? "?")} | conflict | ${forecastJoin.stateOf(row)} |`,
          ),
          // A path that conflicts on `origin/main` but not at the tag has no census row,
          // so the union adds it here. The tagged cell may only read `not observed` from
          // a complete census; a partial one cannot say it never conflicts.
          ...forecastJoin.mainOnly.map(
            (row) =>
              `| — | ${cell(row.path)} | — | — |${evidence.version === 1 ? "" : " — |"} ${cell(`${row.commit} ${row.subject}`)} | ${cell(row.domain)} | ${evidence.complete ? "not observed" : "unknown (partial)"} | conflict |`,
          ),
          `<!-- sequential-census-v${evidence.version}:${JSON.stringify(evidence).replaceAll("<", "\\u003c")} -->`,
        ]),
    ...(stopCensus?.truncatedBy === "stop-limit"
      ? [
          `The census stopped at its conflict-stop limit of ${stopCensus.stopLimit}, so these are lower-bound counts.`,
        ]
      : stopCensus?.truncatedBy === "time-limit"
        ? [
            `The census stopped at its wall-clock limit of ${stopCensus.timeLimitSeconds} seconds, so these are lower-bound counts.`,
          ]
        : []),
    "",
    "Follow [Unblocking a rebase-blocked issue](https://github.com/RSI-Software/t3code-hyprws/blob/hyprws/docs/fork/operations/fork-sync.md#unblocking-a-rebase-blocked-issue).",
    // The census table is the report once it exists. A legacy count-only census keeps the
    // markerless four-column overlap table, which is still the only thing its reader parses.
    ...(evidence !== undefined
      ? []
      : [
          "",
          "## Feasibility overlap",
          "",
          "| File | Hunks | Fork commit | Domain |",
          "| --- | ---: | --- | --- |",
          ...conflicts.map(
            (conflict) =>
              `| ${inlineCode(conflict.path.replaceAll("|", "\\|"))} | ${conflict.hunks} | ${inlineCode(`${conflict.forkCommitShort} ${conflict.forkSubject.replaceAll("|", "\\|")}`)} | ${conflict.domain ?? "?"} |`,
          ),
        ]),
    "",
    "<!-- gh-bot:relationships:start -->",
    "Relationships: none (`--no-relationship`).",
    '<!-- gh-bot:relationships {"v":2,"blockedBy":[],"blocking":[],"relatesTo":[],"noRelationship":true,"position":null} -->',
    "<!-- gh-bot:relationships:end -->",
    "",
    `<!-- blocking-sha:${first.sha} -->`,
  ].join("\n");
  return {
    title: blockedIssueTitle(horizon.tag, first.shortSha),
    label: "rebase-blocked",
    blockingSha: first.sha,
    blockingShortSha: first.shortSha,
    subject: first.subject,
    remainingUpstreamCount: remaining,
    newestUpstreamTagBeyondWindow: plan.newestTagBeyondWindow?.tag ?? null,
    stopCensus,
    stopCensusUnavailableReason,
    conflicts,
    body,
  };
};
