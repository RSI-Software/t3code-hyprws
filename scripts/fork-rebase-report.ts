#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone Git report runs before an Effect runtime exists.

// Generates the repository orientation used before a hyprws upstream rebase.
// The report is derived only from Git refs and commit metadata: unchanged refs
// produce byte-identical Markdown and JSON.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as NodePath from "node:path";

export const DEFAULT_JSON_PATH = "docs/internals/generated/fork-rebase-report.json";
export const DEFAULT_MARKDOWN_PATH = "docs/internals/generated/fork-rebase-report.md";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const LANE_WIDTH = 60;

const CONVENTIONAL_TYPE_ORDER = [
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

export interface ReportCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly type: string | null;
}

export interface ReportRepository {
  readonly slug: string | null;
  readonly webUrl: string | null;
}

export interface ReportRelease {
  readonly tag: string;
  readonly sha: string;
  readonly shortSha: string;
  readonly commitsSincePrevious: ReadonlyArray<ReportCommit>;
}

export interface ReportLane {
  readonly ref: string;
  readonly sha: string;
  readonly shortSha: string;
  readonly repository: ReportRepository;
  readonly commitCount: number;
  readonly changeTypes: Readonly<Record<string, number>>;
  readonly releases: ReadonlyArray<ReportRelease>;
  readonly unreleasedCommits: ReadonlyArray<ReportCommit>;
}

export interface ForkRebaseReport {
  readonly schemaVersion: 1;
  readonly generatedBy: "vp run fork:rebase-report";
  readonly sharedBase: {
    readonly sha: string;
    readonly shortSha: string;
    readonly upstreamTags: ReadonlyArray<string>;
  };
  readonly upstream: ReportLane;
  readonly hyprws: ReportLane;
}

export interface ReportOptions {
  readonly source: string;
  readonly target: string;
  readonly jsonOut: string;
  readonly markdownOut: string;
  readonly fetch: boolean;
  readonly check: boolean;
}

export interface GitReader {
  readonly run: (args: ReadonlyArray<string>) => string;
}

const HELP = `Usage: vp run fork:rebase-report [options]

Generate the Git orientation snapshot used before rebasing hyprws.

Options:
  --source <ref>         Fork ref (default: origin/hyprws)
  --target <ref>         Upstream ref (default: upstream/main)
  --json-out <path>      JSON path relative to repo root
  --markdown-out <path>  Markdown path relative to repo root
  --fetch                Fetch both remote refs and tags first
  --check                Exit 1 instead of writing when outputs are stale
  -h, --help             Show help
  -V, --version          Show schema version

Manual update:
  vp run fork:rebase-report --fetch
`;

const defaultOptions = (): ReportOptions => ({
  source: "origin/hyprws",
  target: "upstream/main",
  jsonOut: DEFAULT_JSON_PATH,
  markdownOut: DEFAULT_MARKDOWN_PATH,
  fetch: false,
  check: false,
});

export class UsageError extends Error {}

export const parseArgs = (argv: ReadonlyArray<string>): ReportOptions => {
  const options = { ...defaultOptions() };
  const seen = new Set<string>();
  const valueFlags = new Set(["--source", "--target", "--json-out", "--markdown-out"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (
      argument === "-h" ||
      argument === "--help" ||
      argument === "-V" ||
      argument === "--version"
    ) {
      continue;
    }
    if (argument === "--fetch" || argument === "--check") {
      if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
      seen.add(argument);
      if (argument === "--fetch") options.fetch = true;
      else options.check = true;
      continue;
    }
    if (!valueFlags.has(argument)) throw new UsageError(`unknown option: ${argument}`);
    if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new UsageError(`missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--source") options.source = value;
    else if (argument === "--target") options.target = value;
    else if (argument === "--json-out") options.jsonOut = value;
    else options.markdownOut = value;
  }

  if (options.source.length === 0) throw new UsageError("--source cannot be empty");
  if (options.target.length === 0) throw new UsageError("--target cannot be empty");
  if (options.jsonOut === options.markdownOut) {
    throw new UsageError("--json-out and --markdown-out must be different paths");
  }
  return options;
};

class SystemGit implements GitReader {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  run(args: ReadonlyArray<string>): string {
    return execFileSync("git", [...args], {
      cwd: this.cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  }
}

export const classifyChangeType = (subject: string): string | null => {
  const match = /^(?<type>[a-z][a-z0-9-]*)(?:\([^)]*\))?!?:\s/.exec(subject);
  return match?.groups?.type ?? null;
};

export const parseCommitLog = (raw: string): ReadonlyArray<ReportCommit> =>
  raw
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const separator = record.indexOf(FIELD_SEPARATOR);
      if (separator === -1) throw new Error("git log returned a malformed record");
      const sha = record.slice(0, separator);
      const subject = record.slice(separator + 1).replace(/\n+$/, "");
      return {
        sha,
        shortSha: sha.slice(0, 7),
        subject,
        type: classifyChangeType(subject),
      };
    });

const readCommits = (
  git: GitReader,
  startSha: string,
  endSha: string,
): ReadonlyArray<ReportCommit> => {
  if (startSha === endSha) return [];
  return parseCommitLog(
    git.run([
      "log",
      "--reverse",
      "--topo-order",
      `--format=%H${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`,
      `${startSha}..${endSha}`,
    ]),
  );
};

const canonicalRepository = (remoteUrl: string): ReportRepository => {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  const scp = /^(?:[^@]+@)?(?<host>[^:]+):(?<path>.+)$/.exec(trimmed);
  if (scp?.groups?.host && scp.groups.path) {
    const webUrl = `https://${scp.groups.host}/${scp.groups.path}`;
    return {
      slug: scp.groups.host === "github.com" ? scp.groups.path : null,
      webUrl,
    };
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { slug: null, webUrl: null };
    }
    const path = url.pathname.replace(/^\//, "");
    const webUrl = `${url.protocol}//${url.host}/${path}`;
    return { slug: url.host === "github.com" ? path : null, webUrl };
  } catch {
    return { slug: null, webUrl: null };
  }
};

const remoteFromRef = (ref: string): string | null => {
  const separator = ref.indexOf("/");
  return separator <= 0 ? null : ref.slice(0, separator);
};

const repositoryForRef = (git: GitReader, ref: string): ReportRepository => {
  const remote = remoteFromRef(ref);
  return remote === null
    ? { slug: null, webUrl: null }
    : canonicalRepository(git.run(["remote", "get-url", remote]));
};

const listReachableTags = (
  git: GitReader,
  baseSha: string,
  headSha: string,
  accepts: (tag: string) => boolean,
): ReadonlyArray<{ readonly tag: string; readonly sha: string }> => {
  const candidates = git
    .run([
      "tag",
      "--list",
      "v*",
      "--merged",
      headSha,
      "--contains",
      baseSha,
      "--sort=version:refname",
    ])
    .split("\n")
    .filter((tag) => tag.length > 0 && accepts(tag))
    .map((tag) => ({ tag, sha: git.run(["rev-parse", `${tag}^{commit}`]).trim() }));

  const commitOrder = new Map(
    git
      .run(["rev-list", "--reverse", "--topo-order", `${baseSha}..${headSha}`])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((sha, index) => [sha, index] as const),
  );
  return candidates.toSorted((left, right) => {
    const leftIndex =
      left.sha === baseSha ? -1 : (commitOrder.get(left.sha) ?? Number.MAX_SAFE_INTEGER);
    const rightIndex =
      right.sha === baseSha ? -1 : (commitOrder.get(right.sha) ?? Number.MAX_SAFE_INTEGER);
    return leftIndex - rightIndex;
  });
};

const buildReleases = (
  git: GitReader,
  baseSha: string,
  tags: ReadonlyArray<{ readonly tag: string; readonly sha: string }>,
): ReadonlyArray<ReportRelease> => {
  let previousSha = baseSha;
  return tags.map(({ tag, sha }) => {
    const commitsSincePrevious = readCommits(git, previousSha, sha);
    previousSha = sha;
    return { tag, sha, shortSha: sha.slice(0, 7), commitsSincePrevious };
  });
};

const countChangeTypes = (
  commits: ReadonlyArray<ReportCommit>,
): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const commit of commits) {
    const type = commit.type ?? "other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const known = CONVENTIONAL_TYPE_ORDER.filter((type) => counts.has(type));
  const custom = [...counts.keys()]
    .filter((type) => type !== "other" && !CONVENTIONAL_TYPE_ORDER.includes(type as never))
    .toSorted();
  const keys = [...known, ...custom, ...(counts.has("other") ? ["other"] : [])];
  return Object.fromEntries(keys.map((key) => [key, counts.get(key) ?? 0]));
};

const buildLane = (
  git: GitReader,
  baseSha: string,
  ref: string,
  headSha: string,
  tagFilter: (tag: string) => boolean,
): ReportLane => {
  const releases = buildReleases(git, baseSha, listReachableTags(git, baseSha, headSha, tagFilter));
  const previousSha = releases.at(-1)?.sha ?? baseSha;
  const allCommits = readCommits(git, baseSha, headSha);
  return {
    ref,
    sha: headSha,
    shortSha: headSha.slice(0, 7),
    repository: repositoryForRef(git, ref),
    commitCount: allCommits.length,
    changeTypes: countChangeTypes(allCommits),
    releases,
    unreleasedCommits: readCommits(git, previousSha, headSha),
  };
};

export const buildReport = (git: GitReader, source: string, target: string): ForkRebaseReport => {
  const sourceSha = git.run(["rev-parse", `${source}^{commit}`]).trim();
  const targetSha = git.run(["rev-parse", `${target}^{commit}`]).trim();
  const baseSha = git.run(["merge-base", sourceSha, targetSha]).trim();
  const isUpstreamRelease = (tag: string) =>
    /^v\d+\.\d+\.\d+(?:$|-)/.test(tag) && !/-hyprws\.\d+$/.test(tag);
  const isForkRelease = (tag: string) => /^v\d+\.\d+\.\d+-hyprws\.\d+$/.test(tag);
  const upstream = buildLane(git, baseSha, target, targetSha, isUpstreamRelease);
  const hyprws = buildLane(git, baseSha, source, sourceSha, isForkRelease);

  return {
    schemaVersion: 1,
    generatedBy: "vp run fork:rebase-report",
    sharedBase: {
      sha: baseSha,
      shortSha: baseSha.slice(0, 7),
      upstreamTags: upstream.releases
        .filter((release) => release.sha === baseSha)
        .map((release) => release.tag),
    },
    upstream,
    hyprws,
  };
};

const pluralizedCommits = (count: number, qualifier?: string): string => {
  const suffix = count === 1 ? "commit" : "commits";
  return `${count}${qualifier ? ` ${qualifier}` : ""} ${suffix}`;
};

interface GraphNode {
  readonly label: string;
  readonly incoming?: string;
}

const graphRows = (nodes: ReadonlyArray<GraphNode>): ReadonlyArray<string> => {
  const rows: Array<string> = [];
  for (const [index, node] of nodes.entries()) {
    if (index > 0) {
      rows.push("        │", `        │ ${node.incoming ?? ""}`, "        v");
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
      ...(nodes.length === 0
        ? {}
        : { incoming: pluralizedCommits(release.commitsSincePrevious.length) }),
    });
  }
  if (nodes.length === 0) nodes.push({ label: `upstream base @ ${report.sharedBase.shortSha}` });
  nodes.push({
    label: `${report.upstream.ref} @ ${report.upstream.shortSha}`,
    incoming: pluralizedCommits(report.upstream.unreleasedCommits.length, "untagged"),
  });
  return nodes;
};

const hyprwsGraphNodes = (report: ForkRebaseReport): ReadonlyArray<GraphNode> => [
  { label: `fork base @ ${report.sharedBase.shortSha}` },
  ...report.hyprws.releases.map((release) => ({
    label: `${release.tag} @ ${release.shortSha}`,
    incoming: pluralizedCommits(release.commitsSincePrevious.length),
  })),
  {
    label: `${report.hyprws.ref} @ ${report.hyprws.shortSha}`,
    incoming: pluralizedCommits(report.hyprws.unreleasedCommits.length, "unreleased"),
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
  const nightly = /-nightly\.\d{8}\.(?<run>\d+)$/.exec(tag);
  return nightly?.groups?.run ? `nightly ${nightly.groups.run}` : `release ${tag}`;
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
    "## State",
    "",
    "```text",
    renderStateGraph(report),
    "```",
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

const resolveOutput = (root: string, output: string): string => {
  const resolved = NodePath.resolve(root, output);
  const relative = NodePath.relative(root, resolved);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new UsageError(`output path must stay inside the repository: ${output}`);
  }
  return resolved;
};

const writeAtomically = (path: string, contents: string): void => {
  mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, contents, "utf8");
  renameSync(temporary, path);
};

const fetchRef = (git: GitReader, ref: string): void => {
  const remote = remoteFromRef(ref);
  if (remote === null) throw new UsageError(`--fetch requires a remote-tracking ref: ${ref}`);
  const branch = ref.slice(remote.length + 1);
  git.run(["fetch", "--prune", "--tags", remote, branch]);
};

export const run = (argv: ReadonlyArray<string>, cwd = process.cwd()): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("-V") || argv.includes("--version")) {
    process.stdout.write("1\n");
    return 0;
  }

  try {
    const options = parseArgs(argv);
    const bootstrapGit = new SystemGit(cwd);
    const root = bootstrapGit.run(["rev-parse", "--show-toplevel"]).trim();
    const git = new SystemGit(root);
    if (options.fetch) {
      fetchRef(git, options.source);
      fetchRef(git, options.target);
    }
    const report = buildReport(git, options.source, options.target);
    const outputs = [
      {
        relative: options.jsonOut,
        path: resolveOutput(root, options.jsonOut),
        contents: encodeReportJson(report),
      },
      {
        relative: options.markdownOut,
        path: resolveOutput(root, options.markdownOut),
        contents: renderMarkdown(report),
      },
    ];

    if (options.check) {
      const stale = outputs.filter(
        (output) =>
          !existsSync(output.path) || readFileSync(output.path, "utf8") !== output.contents,
      );
      if (stale.length > 0) {
        for (const output of stale) process.stderr.write(`stale: ${output.relative}\n`);
        process.stderr.write("run: vp run fork:rebase-report --fetch\n");
        return 1;
      }
      process.stdout.write("current: fork rebase report\n");
      return 0;
    }

    for (const output of outputs) {
      writeAtomically(output.path, output.contents);
      process.stdout.write(`updated: ${output.relative}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`failed: ${message}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
