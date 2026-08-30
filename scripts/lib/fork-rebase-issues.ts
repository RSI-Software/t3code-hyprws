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
  readonly conflictingForkCommitCount: number;
  readonly conflictingFileCount: number;
  readonly truncated: boolean;
  readonly truncatedBy: "stop-limit" | "time-limit" | null;
  readonly stopLimit: number;
  readonly timeLimitSeconds: number;
}

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
  const tagNode = tag.includes("-nightly.") ? "N" : "S";
  return ["o", "X", ...commits, tagNode].join("--");
};

export const refreshRow = (input: RefreshRowInput): string =>
  `#${input.index} ${refreshTimestamp(input.at)}  hyprws  ${refreshLane(input.tag, input.upstreamCommitCount)}  ${input.tag}  ${input.conflictingForkCommitCount ?? "?"}c`;

export const closeComment = (trunkSha: string | null): string =>
  trunkSha === null ? "Resolved: no longer conflicts." : `Resolved by hyprws ${trunkSha}.`;

export const stableCandidateBody = (
  tag: string,
  branch: string,
  mode: RebaseMode,
): string => `The auto-rebase bot created \`${branch}\` from the fork stack rebased onto \`${tag}\`.
${
  mode === "candidate"
    ? "\nCandidate mode created this snapshot from a stack the trunk has not adopted. If that candidate is rejected, the create-only snapshot is hand-fix-only; the bot will not overwrite it.\n"
    : ""
}
Cut the next stable fork release after human verification:

\`\`\`bash
git fetch origin
git switch --detach origin/${branch}
vp run fork:delta --check
git tag v${tag.slice(1)}-hyprws.<n>
git push origin v${tag.slice(1)}-hyprws.<n>
\`\`\`

Follow [Cut a stable release](https://github.com/RSI-Software/t3code-hyprws/blob/hyprws/docs/operations/fork-sync.md#cut-a-stable-release) for verification and the release record.

<!-- hyprws-stable-candidate: ${tag}-hyprws -->`;

interface BlockedPlan {
  readonly target: { readonly tag: string } | null;
  readonly newestTagBeyondWindow: { readonly tag: string } | null;
  readonly feasibility: ForkRebaseFeasibility;
}

export const buildBlockedIssue = (
  plan: BlockedPlan,
  stopCensus: RebaseStopCensus | null = null,
  stopCensusUnavailableReason: string | null = null,
): BlockedIssue | null => {
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
    stopCensusUnavailableReason !== null
      ? `The sequential rebase census was unavailable: ${inlineCode(stopCensusUnavailableReason)}.`
      : stopCensus === null
        ? "No upstream release tag exists beyond this block, so there is no tagged rebase target to rehearse."
        : `A throwaway rebase rehearsal to ${inlineCode(stopCensus.targetTag)} found ${stopCensus.conflictingForkCommitCount} conflicting fork ${stopCensus.conflictingForkCommitCount === 1 ? "commit" : "commits"} and ${stopCensus.conflictingFileCount} conflict-file ${stopCensus.conflictingFileCount === 1 ? "resolution" : "resolutions"}. Repeated paths count at each stop.`,
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
