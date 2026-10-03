import type { ForkRebaseFeasibility } from "./fork-rebase-feasibility.ts";
import { parseUpstreamReleaseTag } from "./fork-policy.ts";

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

export interface SequentialCensusEvidence {
  readonly version: 1;
  readonly method: "sequential-rebase-stage3-provisional";
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
  }>;
}

export const censusTotals = (rows: SequentialCensusEvidence["rows"]) => ({
  conflictingForkCommitCount: new Set(rows.map((row) => row.commit)).size,
  conflictingFileCount: rows.length,
});

/** The marker retains exact paths and provenance independently of Markdown escaping. */
export const parseSequentialCensusEvidence = (body: string): SequentialCensusEvidence | null => {
  const marker = /<!-- sequential-census-v1:(.*?) -->/.exec(body)?.[1];
  if (marker === undefined) return null;
  return requireSequentialCensusEvidence(JSON.parse(marker));
};

export const requireSequentialCensusEvidence = (value: unknown): SequentialCensusEvidence => {
  if (typeof value !== "object" || value === null) throw new Error("invalid census evidence");
  const evidence = value as Record<string, unknown>;
  const sha = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
  if (
    evidence.version !== 1 ||
    evidence.method !== "sequential-rebase-stage3-provisional" ||
    !sha(evidence.sourceSha) ||
    !sha(evidence.baseSha) ||
    !sha(evidence.targetSha) ||
    typeof evidence.targetTag !== "string" ||
    typeof evidence.complete !== "boolean" ||
    !Array.isArray(evidence.rows)
  )
    throw new Error("invalid census provenance");
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
        row.kind !== "other-unmerged")
    )
      throw new Error("invalid census stop row");
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
    };
  });
  return {
    version: 1,
    method: evidence.method,
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

export interface RefreshRowInput {
  readonly index: number;
  readonly at: Date;
  readonly blockingShortSha: string;
  readonly tag: string;
  readonly upstreamCommitCount: number;
  readonly conflictingForkCommitCount: number | null;
}

const refreshTimestamp = (at: Date): string =>
  `${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")} ${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;

const refreshLane = (tag: string, upstreamCommitCount: number): string => {
  const commitsAfterBlock = Math.max(0, upstreamCommitCount - 1);
  const commits =
    commitsAfterBlock <= 8
      ? Array.from({ length: commitsAfterBlock }, () => "o")
      : [`o x${commitsAfterBlock}`];
  const tagNode = parseUpstreamReleaseTag(tag)?.channel === "nightly" ? "N" : "S";
  return ["o", "X", ...commits, tagNode].join("--");
};

export const refreshRow = (input: RefreshRowInput): string =>
  `#${input.index} ${refreshTimestamp(input.at)}  hyprws  ${refreshLane(input.tag, input.upstreamCommitCount)}  ${input.tag}  ${input.conflictingForkCommitCount ?? "?"}c`;

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

Every step stops for a human decision, and \`stable-prepare\` renders the UAT draft. [Cut a stable release](https://github.com/RSI-Software/t3code-hyprws/blob/hyprws/docs/operations/fork-sync.md#cut-a-stable-release) owns the verification and the release record.

<!-- hyprws-stable-candidate: ${tag}-hyprws -->`;

interface BlockedPlan {
  readonly oldSha?: string;
  readonly baseSha?: string;
  readonly horizon?: { readonly sha: string } | null;
  readonly target: { readonly tag: string } | null;
  readonly newestTagBeyondWindow: { readonly tag: string } | null;
  readonly feasibility: ForkRebaseFeasibility;
}

export const buildBlockedIssue = (
  plan: BlockedPlan,
  stopCensus: RebaseStopCensus | null = null,
  stopCensusUnavailableReason: string | null = null,
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
      ? [
          "Legacy count-only sequential measurement: stop rows and replay SHAs were not retained. Feasibility overlap below is a different measurement, not evidence for these totals.",
        ]
      : [
          `Method: ${inlineCode(evidence.method)}. Source: ${inlineCode(evidence.sourceSha)}; base: ${inlineCode(evidence.baseSha)}; target: ${inlineCode(evidence.targetSha)}. ${evidence.complete ? "Complete" : "Partial"} observation set.`,
          "Continuation provisionally takes fork-side index stage 3 (or its deletion) with rerere disabled. These observations record no human or agent resolution verdict.",
          "",
          "| Stop | File | Conflict kind | Replayed fork commit | Domain |",
          "| ---: | --- | --- | --- | --- |",
          ...evidence.rows.map(
            (row) =>
              `| ${row.stop} | ${cell(row.path)} | ${row.kind} | ${cell(`${row.commit} ${row.subject}`)} | ${cell(row.domain ?? "?")} |`,
          ),
          `<!-- sequential-census-v1:${JSON.stringify(evidence).replaceAll("<", "\\u003c")} -->`,
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
    "## Feasibility overlap",
    "",
    `Pairwise merge-tree analysis: ${new Set(conflicts.map((conflict) => conflict.forkCommit)).size} introducing fork commits and ${conflicts.length} file rows. Complete overlap table, independent of sequential stop counts.`,
    `Source: ${inlineCode(plan.oldSha ?? "unknown (legacy report)")}; base: ${inlineCode(plan.baseSha ?? "unknown (legacy report)")}; upstream: ${inlineCode(plan.horizon?.sha ?? "unknown (legacy report)")}. Attribution names the introducing fork commit, not a sequential replay stop.`,
    "",
    "Follow [Unblocking a rebase-blocked issue](https://github.com/RSI-Software/t3code-hyprws/blob/hyprws/docs/operations/fork-sync.md#unblocking-a-rebase-blocked-issue).",
    "",
    "| File | Hunks | Fork commit | Domain |",
    "| --- | ---: | --- | --- |",
    ...conflicts.map(
      (conflict) =>
        `| ${inlineCode(conflict.path.replaceAll("|", "\\|"))} | ${conflict.hunks} | ${inlineCode(`${conflict.forkCommitShort} ${conflict.forkSubject.replaceAll("|", "\\|")}`)} | ${conflict.domain ?? "?"} |`,
    ),
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
