import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import { parseUpstreamReleaseTag } from "./lib/fork-policy.ts";
import type {
  ForkRebaseReport,
  ReportCommit,
  ReportLane,
  ReportRepository,
} from "./fork-rebase-report.ts";

const LANE_WIDTH = 60;

export const CONVENTIONAL_TYPE_ORDER = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
] as const;

const pluralizedCommits = (count: number, qualifier?: string): string => {
  const suffix = count === 1 ? "commit" : "commits";
  return `${count}${qualifier ? ` ${qualifier}` : ""} ${suffix}`;
};

interface GraphEdge {
  readonly count: number;
  readonly qualifier?: string;
}

interface GraphNode {
  readonly label: string;
  readonly incoming?: GraphEdge;
}

// A rung reached by no commits is another name for the rung above it: a nightly
// alias of the same commit, or the target ref once its own tag already sits
// there. The later name wins and inherits the edge that reached the pair, so the
// ladder names each commit once and ends on the target.
export const collapseAliasNodes = (nodes: ReadonlyArray<GraphNode>): ReadonlyArray<GraphNode> =>
  nodes.reduce<Array<GraphNode>>((kept, node) => {
    const previous = kept.at(-1);
    if (previous === undefined || node.incoming === undefined || node.incoming.count > 0) {
      kept.push(node);
      return kept;
    }
    kept[kept.length - 1] = {
      label: node.label,
      ...(previous.incoming === undefined ? {} : { incoming: previous.incoming }),
    };
    return kept;
  }, []);

const graphRows = (nodes: ReadonlyArray<GraphNode>): ReadonlyArray<string> => {
  const rows: Array<string> = [];
  for (const [index, node] of collapseAliasNodes(nodes).entries()) {
    if (index > 0) {
      const incoming =
        node.incoming === undefined
          ? ""
          : pluralizedCommits(node.incoming.count, node.incoming.qualifier);
      rows.push("        │", `        │ ${incoming}`, "        v");
    }
    rows.push(node.label);
  }
  return rows;
};

const upstreamGraphNodes = (report: ForkRebaseReport): ReadonlyArray<GraphNode> => {
  const nodes: Array<GraphNode> = [];
  if (report.upstream.releases[0]?.sha !== report.sharedBase.sha) {
    nodes.push({ label: `upstream base @ ${report.sharedBase.shortSha}` });
  }
  for (const release of report.upstream.releases) {
    nodes.push({
      label: `${release.tag} @ ${release.shortSha}`,
      ...(nodes.length === 0 ? {} : { incoming: { count: release.commitsSincePrevious.length } }),
    });
  }
  if (nodes.length === 0) nodes.push({ label: `upstream base @ ${report.sharedBase.shortSha}` });
  nodes.push({
    label: `${report.upstream.ref} @ ${report.upstream.shortSha}`,
    incoming: { count: report.upstream.unreleasedCommits.length, qualifier: "untagged" },
  });
  return nodes;
};

const hyprwsGraphNodes = (report: ForkRebaseReport): ReadonlyArray<GraphNode> => [
  { label: `fork base @ ${report.sharedBase.shortSha}` },
  ...report.hyprws.releases.map((release) => ({
    label: `${release.tag} @ ${release.shortSha}`,
    incoming: { count: release.commitsSincePrevious.length },
  })),
  {
    label: `${report.hyprws.ref} @ ${report.hyprws.shortSha}`,
    incoming: { count: report.hyprws.unreleasedCommits.length, qualifier: "unreleased" },
  },
];

export const renderStateGraph = (report: ForkRebaseReport): string => {
  const upstreamRows = graphRows(upstreamGraphNodes(report));
  const hyprwsRows = graphRows(hyprwsGraphNodes(report));
  const bodyRows = Array.from(
    { length: Math.max(upstreamRows.length, hyprwsRows.length) },
    (_, index) => (upstreamRows[index] ?? "").padEnd(LANE_WIDTH) + (hyprwsRows[index] ?? ""),
  );
  return [
    `${" ".repeat(34)}${report.sharedBase.shortSha}`,
    `${" ".repeat(29)}shared fork base`,
    `${" ".repeat(36)}│`,
    `${" ".repeat(8)}┌${"─".repeat(27)}┴${"─".repeat(27)}┐`,
    `${" ".repeat(8)}│${" ".repeat(55)}│`,
    `${" ".repeat(8)}v${" ".repeat(55)}v`,
    "UPSTREAM".padEnd(LANE_WIDTH) + "HYPRWS",
    "",
    ...bodyRows.map((row) => row.trimEnd()),
  ].join("\n");
};

const refMarkdown = (lane: ReportLane): string => {
  const label = `\`${lane.ref}\``;
  return lane.repository.webUrl === null
    ? `${label} at \`${lane.shortSha}\``
    : `[${label}](${lane.repository.webUrl}/tree/${lane.sha}) at \`${lane.shortSha}\``;
};

const commitMarkdown = (commit: ReportCommit, repository: ReportRepository): string => {
  const sha = `\`${commit.shortSha}\``;
  const label =
    repository.webUrl === null ? sha : `[${sha}](${repository.webUrl}/commit/${commit.sha})`;
  return `- ${label} ${commit.subject}`;
};

const dividerLabel = (tag: string, fork: boolean): string => {
  if (fork) return `release ${tag}`;
  const parsed = parseUpstreamReleaseTag(tag);
  return parsed?.channel === "nightly" ? `nightly ${parsed.runNumber}` : `release ${tag}`;
};

const divider = (label: string): string => {
  const side = Math.max(8, Math.floor((60 - label.length - 4) / 2));
  return `${"-".repeat(side)}[ ${label} ]${"-".repeat(side)}`;
};

const renderCommitSections = (lane: ReportLane, fork: boolean): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  for (const release of lane.releases) {
    if (release.commitsSincePrevious.length === 0) continue;
    lines.push(divider(dividerLabel(release.tag, fork)), "");
    lines.push(
      ...release.commitsSincePrevious.map((commit) => commitMarkdown(commit, lane.repository)),
    );
    lines.push("");
  }
  if (lane.unreleasedCommits.length > 0) {
    lines.push(divider(`unreleased ${lane.ref}`), "");
    lines.push(...lane.unreleasedCommits.map((commit) => commitMarkdown(commit, lane.repository)));
    lines.push("");
  }
  return lines;
};

const escapeTableCell = (value: string): string => value.replaceAll("|", "\\|");

const linkedSha = (sha: string, repository: ReportRepository): string => {
  const shortSha = sha.slice(0, 7);
  return repository.webUrl === null
    ? `\`${shortSha}\``
    : `[\`${shortSha}\`](${repository.webUrl}/commit/${sha})`;
};

const feasibilitySummary = (report: ForkRebaseReport): string => {
  const { ffBoundary, conflicts } = report.feasibility;
  const hunks = conflicts.reduce((total, conflict) => total + conflict.hunkCount, 0);
  const forkCommits = new Set(conflicts.map((conflict) => conflict.introducingForkCommit.sha));
  const domains = new Set(
    conflicts.flatMap((conflict) =>
      conflict.introducingForkCommit.domain === null ? [] : [conflict.introducingForkCommit.domain],
    ),
  );
  return `Feasibility: clean through ${ffBoundary.cleanCommitCount}/${ffBoundary.upstreamCommitCount} upstream commits; ${conflicts.length} ${conflicts.length === 1 ? "file" : "files"} / ${hunks} ${hunks === 1 ? "hunk" : "hunks"} conflict vs ${report.upstream.ref} (${forkCommits.size} fork ${forkCommits.size === 1 ? "commit" : "commits"}, ${domains.size} ${domains.size === 1 ? "domain" : "domains"}).`;
};

export const renderRetireCandidates = (report: ForkRebaseReport): ReadonlyArray<string> => {
  const lines = ["## Retire candidates", ""];
  if (report.retireCandidates.length === 0) return [...lines, "None."];
  lines.push(
    "| Fork commit | Domain | Tier | Signals | Decision |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const candidate of report.retireCandidates) {
    const signals = candidate.signals
      .map((signal) => `\`${signal.kind}\`: ${escapeTableCell(signal.evidence)}`)
      .join("<br>");
    const decision =
      candidate.decision === "none"
        ? "candidate"
        : candidate.decision === "keep"
          ? `kept${candidate.reason === undefined ? "" : ` — ${escapeTableCell(candidate.reason)}`}`
          : `${candidate.decision}${candidate.reason === undefined ? "" : ` — ${escapeTableCell(candidate.reason)}`}`;
    lines.push(
      `| ${linkedSha(candidate.commit, report.hyprws.repository)} ${escapeTableCell(candidate.subject)} | ${candidate.domain ?? "?"} | ${candidate.tier ?? "?"} | ${signals} | ${decision} |`,
    );
  }
  return lines;
};

const renderFeasibility = (report: ForkRebaseReport): ReadonlyArray<string> => {
  const { ffBoundary, conflicts, overlap } = report.feasibility;
  const lines: Array<string> = [
    "## Feasibility",
    "",
    feasibilitySummary(report),
    "",
    "**Fast-forward boundary.**",
    "",
  ];
  if (ffBoundary.firstConflict === null) {
    lines.push(
      `The fork stack merges cleanly through all ${ffBoundary.upstreamCommitCount} upstream commits.`,
    );
  } else {
    const commit = ffBoundary.firstConflict;
    const tags =
      commit.tags.length === 0 ? "" : ` (${commit.tags.map((tag) => `\`${tag}\``).join(", ")})`;
    lines.push(
      `The first conflict is upstream commit ${linkedSha(commit.sha, report.upstream.repository)}${tags}: ${commit.subject}`,
    );
  }
  lines.push("");
  if (ffBoundary.changes.length > 0) {
    lines.push("| Upstream commit | Tags | Files added to conflict set |", "| --- | --- | --- |");
    for (const change of ffBoundary.changes) {
      lines.push(
        `| ${linkedSha(change.sha, report.upstream.repository)} ${escapeTableCell(change.subject)} | ${change.tags.map((tag) => `\`${tag}\``).join(", ")} | ${change.filesAdded.map((path) => `\`${path}\``).join("<br>")} |`,
      );
    }
  } else {
    lines.push("No upstream commit adds a conflict.");
  }

  lines.push("", `**Conflicts against \`${report.upstream.ref}\`.**`, "");
  if (conflicts.length > 0) {
    lines.push(
      "| File | Hunks | Introducing fork commit | Domain | Tier |",
      "| --- | ---: | --- | --- | --- |",
    );
    for (const conflict of conflicts) {
      const commit = conflict.introducingForkCommit;
      lines.push(
        `| \`${conflict.path}\` | ${conflict.hunkCount} | ${linkedSha(commit.sha, report.hyprws.repository)} ${escapeTableCell(commit.subject)} | ${commit.domain ?? "?"} | ${commit.tier ?? "?"} |`,
      );
    }
  } else {
    lines.push("None.");
  }

  lines.push(
    "",
    "**Overlap surface.**",
    "",
    `${overlap.upstreamChanged} upstream-changed files; ${overlap.forkChanged} fork-changed files; ${overlap.overlap} overlap (${overlap.hardConflict} hard-conflict, ${overlap.automerged.length} automerged).`,
    "",
  );
  if (overlap.automerged.length > 0) {
    lines.push("Automerged overlap:", "", ...overlap.automerged.map((path) => `- \`${path}\``));
  } else {
    lines.push("No automerged overlap.");
  }
  return lines;
};

export const renderMarkdown = (report: ForkRebaseReport): string => {
  const changeRows: Array<readonly [string, string, string]> = [];
  const types = [
    ...CONVENTIONAL_TYPE_ORDER,
    ...new Set([
      ...Object.keys(report.upstream.changeTypes),
      ...Object.keys(report.hyprws.changeTypes),
    ]),
  ].filter((type, index, all) => type !== "other" && all.indexOf(type) === index);
  for (const type of types) {
    const upstream = report.upstream.changeTypes[type] ?? 0;
    const hyprws = report.hyprws.changeTypes[type] ?? 0;
    if (upstream === 0 && hyprws === 0) continue;
    changeRows.push([`\`${type}\``, String(upstream), String(hyprws)]);
  }
  const upstreamOther = report.upstream.changeTypes.other ?? 0;
  const hyprwsOther = report.hyprws.changeTypes.other ?? 0;
  if (upstreamOther > 0 || hyprwsOther > 0) {
    changeRows.push(["Other", String(upstreamOther), String(hyprwsOther)]);
  }
  changeRows.push([
    "**Total**",
    `**${report.upstream.commitCount}**`,
    `**${report.hyprws.commitCount}**`,
  ]);
  const tableRows = [["Type", "Upstream", "hyprws"] as const, ...changeRows];
  const widths = [0, 1, 2].map((column) =>
    Math.max(...tableRows.map((row) => row[column]?.length ?? 0)),
  );
  const table = [
    `| ${"Type".padEnd(widths[0] ?? 0)} | ${"Upstream".padStart(widths[1] ?? 0)} | ${"hyprws".padStart(widths[2] ?? 0)} |`,
    `| ${"-".repeat(widths[0] ?? 0)} | ${"-".repeat((widths[1] ?? 0) - 1)}: | ${"-".repeat((widths[2] ?? 0) - 1)}: |`,
    ...changeRows.map(
      ([type, upstream, hyprws]) =>
        `| ${type.padEnd(widths[0] ?? 0)} | ${upstream.padStart(widths[1] ?? 0)} | ${hyprws.padStart(widths[2] ?? 0)} |`,
    ),
  ];
  const lines: Array<string> = [
    "# Fork rebase orientation",
    "",
    "> Generated by `vp run fork:rebase-report`. Do not edit by hand.",
    "",
    `- Source: ${refMarkdown(report.hyprws)}`,
    `- Target: ${refMarkdown(report.upstream)}`,
    `- Shared base: \`${report.sharedBase.shortSha}\`${
      report.sharedBase.upstreamTags.length > 0
        ? ` (${report.sharedBase.upstreamTags.map((tag) => `\`${tag}\``).join(", ")})`
        : ""
    }`,
    "",
    ...renderFeasibility(report),
    "",
    "## State",
    "",
    "```text",
    renderStateGraph(report),
    "```",
    "",
    ...renderRetireCandidates(report),
    "",
    "## Change types",
    "",
    ...table,
  ];

  lines.push(
    "",
    "## Upstream commits/merges",
    "",
    `Range: shared base \`${report.sharedBase.shortSha}\` → \`${report.upstream.ref}\` \`${report.upstream.shortSha}\`.`,
    "",
    ...renderCommitSections(report.upstream, false),
    "## hyprws commits/merges",
    "",
    `Range: shared base \`${report.sharedBase.shortSha}\` → \`${report.hyprws.ref}\` \`${report.hyprws.shortSha}\`.`,
    "",
    ...renderCommitSections(report.hyprws, true),
  );
  return `${lines.join("\n").trimEnd()}\n`;
};

export const encodeReportJson = (report: ForkRebaseReport): string => {
  const encoded = JSON.stringify(report, null, 2);
  const prettyTags = JSON.stringify(report.sharedBase.upstreamTags, null, 2).replaceAll(
    "\n",
    "\n    ",
  );
  const inlineTags = `[${report.sharedBase.upstreamTags.map((tag) => JSON.stringify(tag)).join(", ")}]`;
  const property = `"upstreamTags": ${prettyTags}`;
  const inlineProperty = `"upstreamTags": ${inlineTags}`;
  const formatted =
    `    ${inlineProperty}`.length <= 100 ? encoded.replace(property, inlineProperty) : encoded;
  return `${formatted}\n`;
};
