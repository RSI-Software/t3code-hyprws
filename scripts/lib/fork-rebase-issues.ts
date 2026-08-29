import type { ForkRebaseFeasibility } from "./fork-rebase-feasibility.ts";

// Rebase conflict handling: blocked-rebase issues and RSI bot resolution.
export const BLOCKED_ISSUE_TRACKER = 217;

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

export interface BlockedIssue {
  readonly title: string;
  readonly label: "rebase-blocked";
  readonly trackerNumber: number;
  readonly blockingSha: string;
  readonly blockingShortSha: string;
  readonly subject: string;
  readonly remainingUpstreamCount: number;
  readonly newestUpstreamTagBeyondWindow: string | null;
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

export const buildBlockedIssue = (plan: BlockedPlan): BlockedIssue | null => {
  const first = plan.feasibility.ffBoundary.firstConflict;
  if (first === null) return null;
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
    "Follow [Unblocking a rebase-blocked issue](https://github.com/RSI-Software/t3code-hyprws/blob/hyprws/docs/operations/fork-sync.md#unblocking-a-rebase-blocked-issue).",
    "",
    "| File | Hunks | Fork commit | Domain |",
    "| --- | ---: | --- | --- |",
    ...conflicts.map(
      (conflict) =>
        `| ${inlineCode(conflict.path.replaceAll("|", "\\|"))} | ${conflict.hunks} | ${inlineCode(`${conflict.forkCommitShort} ${conflict.forkSubject.replaceAll("|", "\\|")}`)} | ${conflict.domain ?? "?"} |`,
    ),
    "",
    `Parent: RSI-Software/t3code-hyprws#${BLOCKED_ISSUE_TRACKER}`,
    "",
    "<!-- gh-bot:relationships:start -->",
    "Relationships: none (`--no-relationship`).",
    '<!-- gh-bot:relationships {"v":2,"blockedBy":[],"blocking":[],"relatesTo":[],"noRelationship":true,"position":null} -->',
    "<!-- gh-bot:relationships:end -->",
    "",
    `<!-- blocking-sha:${first.sha} -->`,
  ].join("\n");
  return {
    title: `[📡#${BLOCKED_ISSUE_TRACKER}] 🔔 hyprws auto-rebase is blocked at upstream ${first.shortSha}`,
    label: "rebase-blocked",
    trackerNumber: BLOCKED_ISSUE_TRACKER,
    blockingSha: first.sha,
    blockingShortSha: first.shortSha,
    subject: first.subject,
    remainingUpstreamCount: remaining,
    newestUpstreamTagBeyondWindow: plan.newestTagBeyondWindow?.tag ?? null,
    conflicts,
    body,
  };
};
