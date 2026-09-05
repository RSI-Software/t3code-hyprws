#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone operator script runs before an Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { UsageError } from "./lib/fork-cli.ts";
import {
  SystemInputCommandRunner as SystemRunner,
  type InputCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";

export {
  SystemInputCommandRunner as SystemRunner,
  type CommandResult,
  type InputCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";
import { FORK_REPOSITORY, parseStableForkTag, parseUpstreamReleaseTag } from "./lib/fork-policy.ts";

const REPOSITORY = FORK_REPOSITORY;
const TARGET_VERSION = /^v\d+\.\d+\.\d+-hyprws$/;

import {
  compareNumbers,
  differenceRows,
  partitionUatRows,
  relationshipArguments,
  renderUatBody,
  reviewedUatTasks,
  selectPreviousStable,
  targetVersionFromUpstreamTag,
  upstreamParts,
  type DifferenceRow,
  type ForkLedger,
  type UatTask,
  type Version,
} from "./fork-uat-policy.ts";
import { readPreviousUat } from "./fork-uat-history.ts";
import {
  ensureCreated,
  preparePublication,
  publicationFilePath,
  publicationPath,
  readPublication,
  sealPublication,
} from "./fork-uat-publication.ts";

export {
  differenceRows,
  exclusionReason,
  partitionUatRows,
  legacyUatTasks,
  parentUatBody,
  relationshipArguments,
  renderUatBody,
  renderUatTaskBody,
  reviewedUatTasks,
  selectPreviousStable,
  targetVersionFromUpstreamTag,
  uatTitle,
  type DifferenceRow,
  type ExcludedRow,
  type ExclusionReason,
  type ForkCommit,
  type UatBodyInput,
  type PreviousUat,
  type PriorUatStatus,
  type UatTask,
} from "./fork-uat-policy.ts";

export { UsageError } from "./lib/fork-cli.ts";
export { readPreviousUat } from "./fork-uat-history.ts";

export interface Options {
  readonly ref: string;
  readonly version: string | null;
  readonly since: string | null;
  readonly relatesTo: number | null;
  readonly output: string | null;
  readonly body: string | null;
  readonly bundle: string | null;
  readonly prepare: boolean;
  readonly create: boolean;
  readonly humanApproved: boolean;
}

const HELP = `Usage: vp run fork:uat [--ref <ref>] [--version <version>] [--since <stable-tag>] [--relates-to <issue>] [--output <path>] [--dry-run]
       vp run fork:uat --prepare --body <reviewed-path> [--bundle <directory>]
       vp run fork:uat --create --bundle <directory> --human-approved

Render, preflight, and create a human UAT tracker with acceptance-task sub-issues.

Options:
  --ref <ref>           Ref to evaluate (default hyprws).
  --version <version>   Target version (default vX.Y.Z-hyprws from the upstream base).
  --since <stable-tag>  Override the previous stable tag used for comparison.
  --relates-to <issue>  Relate the UAT issue to repository issue N.
  --output <path>       Draft path (default .dump/fork-uat/uat-<version>.md).
  --dry-run             Render the review draft only (default).
  --prepare             Build and preflight an immutable publication bundle.
  --body <path>         Reviewed draft to prepare.
  --bundle <directory>  Prepared bundle path; defaults to <reviewed-path>.bundle.
  --create              Create the tracker and children from a prepared bundle.
  --human-approved      Record approval of the exact bundle; required by --create.
  -h, --help            Show this help.

Writes:
  Render writes one review draft. Prepare writes a new bundle. Create files GitHub issues and
  resumable receipts inside that bundle.

Exit status: 0 success/help, 1 refusal or runtime failure, 2 usage error.
`;

const positiveIssue = (value: string | undefined, flag: string): number => {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`${flag} requires a positive issue number`);
  }
  return Number(value);
};

export const parseUatArgs = (argv: ReadonlyArray<string>): Options => {
  let ref = "hyprws";
  let version: string | null = null;
  let since: string | null = null;
  let relatesTo: number | null = null;
  let output: string | null = null;
  let body: string | null = null;
  let bundle: string | null = null;
  let prepare = false;
  let create = false;
  let humanApproved = false;
  let mode: "dry-run" | "prepare" | "create" | null = null;
  let hasRenderOptions = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ref") {
      hasRenderOptions = true;
      ref = argv[++index] ?? "";
      if (ref.length === 0) throw new UsageError("--ref requires a Git ref");
    } else if (argument === "--version") {
      hasRenderOptions = true;
      version = argv[++index] ?? "";
      if (!TARGET_VERSION.test(version)) {
        throw new UsageError("--version must match vX.Y.Z-hyprws");
      }
    } else if (argument === "--since") {
      hasRenderOptions = true;
      since = argv[++index] ?? "";
      if (parseStableForkTag(since) === null) {
        throw new UsageError("--since must match vX.Y.Z-hyprws.N");
      }
    } else if (argument === "--relates-to") {
      hasRenderOptions = true;
      relatesTo = positiveIssue(argv[++index], "--relates-to");
    } else if (argument === "--output") {
      hasRenderOptions = true;
      output = argv[++index] ?? null;
      if (output === null || output.length === 0) throw new UsageError("--output requires a path");
    } else if (argument === "--body") {
      body = argv[++index] ?? null;
      if (body === null || body.length === 0) throw new UsageError("--body requires a path");
    } else if (argument === "--bundle") {
      bundle = argv[++index] ?? null;
      if (bundle === null || bundle.length === 0) throw new UsageError("--bundle requires a path");
    } else if (argument === "--human-approved") {
      humanApproved = true;
    } else if (argument === "--create" || argument === "--prepare" || argument === "--dry-run") {
      const requested = argument.slice(2) as "dry-run" | "prepare" | "create";
      if (mode !== null && mode !== requested) {
        throw new UsageError("choose only one of --dry-run, --prepare, or --create");
      }
      mode = requested;
      prepare = requested === "prepare";
      create = requested === "create";
    } else {
      throw new UsageError(`unknown argument ${argument ?? ""}`);
    }
  }
  if (prepare && body === null) throw new UsageError("--prepare requires --body <path>");
  if (create && bundle === null) throw new UsageError("--create requires --bundle <directory>");
  if (!create && humanApproved) throw new UsageError("--human-approved requires --create");
  if (!prepare && body !== null) throw new UsageError("--body requires --prepare");
  if (!prepare && !create && bundle !== null)
    throw new UsageError("--bundle requires --prepare or --create");
  if ((prepare || create) && hasRenderOptions) {
    throw new UsageError("--prepare and --create use reviewed metadata; omit render options");
  }
  return {
    ref,
    version,
    since,
    relatesTo,
    output,
    body,
    bundle,
    prepare,
    create,
    humanApproved,
  };
};

const commandText = (command: string, args: ReadonlyArray<string>): string =>
  [command, ...args]
    .map((value) =>
      /^[A-Za-z0-9_./:@#=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");

const requireSuccess = (
  runner: CommandRunner,
  command: string,
  args: ReadonlyArray<string>,
  input?: string,
): string => {
  const result = runner.run(command, args, input);
  if (result.status === 0) return result.stdout;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(
    `${commandText(command, args)} failed${detail.length === 0 ? "" : `: ${detail}`}`,
  );
};

const parseJsonOutput = <T>(output: string, source: string): T => {
  const start = output.search(/^[{[]/m);
  if (start === -1) throw new Error(`${source} did not print JSON`);
  return JSON.parse(output.slice(start)) as T;
};

export const resolvePreviousStable = (
  runner: CommandRunner,
  since: string | null,
  upstreamVersion: Version,
  tags: ReadonlyArray<string>,
  tagsOnRef: ReadonlyArray<string>,
): { readonly tag: string | null; readonly overridden: boolean } => {
  if (since === null) {
    return { tag: selectPreviousStable(upstreamVersion, tags, tagsOnRef), overridden: false };
  }
  const result = runner.run("git", ["show-ref", "--verify", "--quiet", `refs/tags/${since}`]);
  if (result.status === 0) return { tag: since, overridden: true };
  if (result.status === 1) throw new Error(`--since tag ${since} does not exist`);
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(
    `could not verify --since tag ${since}${detail.length === 0 ? "" : `: ${detail}`}`,
  );
};

export const firstParagraph = (body: string): string =>
  (body.trim().split(/\r?\n\s*\r?\n/, 1)[0] ?? "").replace(/\s+/g, " ").trim();

const sourceContext = (
  runner: CommandRunner,
  row: DifferenceRow,
): { readonly short: string; readonly subject: string; readonly prBody: string | null } => {
  const pullRequest = /\(#([1-9][0-9]*)\)/.exec(row.subject)?.[1];
  if (pullRequest === undefined) return { short: row.short, subject: row.subject, prBody: null };
  const response = parseJsonOutput<{ readonly body: string }>(
    requireSuccess(runner, "gh", [
      "pr",
      "view",
      pullRequest,
      "--repo",
      REPOSITORY,
      "--json",
      "body",
    ]),
    `PR #${pullRequest}`,
  );
  const paragraph = firstParagraph(response.body);
  return { short: row.short, subject: row.subject, prBody: paragraph || null };
};

const patchIdFor = (runner: CommandRunner, sha: string): string | null => {
  const patch = requireSuccess(runner, "git", ["show", "--pretty=format:", sha]);
  const result = runner.run("git", ["patch-id", "--stable"], patch);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`git patch-id --stable failed${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  return result.stdout.trim().split(/\s+/)[0] || null;
};

const readLedger = (runner: CommandRunner, head: string): ForkLedger => {
  const output = requireSuccess(runner, "vp", [
    "run",
    "fork:delta",
    "--base",
    "upstream/main",
    "--head",
    head,
    "--json",
  ]);
  const ledger = parseJsonOutput<ForkLedger>(output, `fork ledger for ${head}`);
  if (!Array.isArray(ledger.commits) || ledger.commits.length === 0) {
    throw new Error(`fork ledger for ${head} is empty`);
  }
  if (!Array.isArray(ledger.findings) || ledger.findings.length > 0) {
    throw new Error(`fork ledger for ${head} has trailer findings`);
  }
  return ledger;
};

const verifyFirstParent = (runner: CommandRunner, head: string): void => {
  const merges = requireSuccess(runner, "git", ["rev-list", "--merges", `upstream/main..${head}`]);
  if (merges.trim().length > 0) throw new Error(`${head} fork history contains merge commits`);
};

const isUpstreamCommit = (runner: CommandRunner, sha: string): boolean => {
  const result = runner.run("git", ["merge-base", "--is-ancestor", sha, "upstream/main"]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`could not test whether ${sha} is already upstream: ${result.stderr.trim()}`);
};

const lines = (output: string): ReadonlyArray<string> =>
  output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);

const checkedOutRefIsDirty = (runner: CommandRunner, ref: string): boolean => {
  const branchResult = runner.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  const normalized = ref.replace(/^refs\/heads\//, "");
  if (ref !== "HEAD" && (branch === null || normalized !== branch)) return false;
  return requireSuccess(runner, "git", ["status", "--porcelain"]).trim().length > 0;
};

const upstreamBase = (
  runner: CommandRunner,
  sha: string,
): { readonly tag: string; readonly sha: string; readonly version: Version } => {
  const baseSha = requireSuccess(runner, "git", ["merge-base", sha, "upstream/main"]).trim();
  const tags = lines(
    requireSuccess(runner, "git", ["tag", "--points-at", baseSha, "--sort=-v:refname"]),
  ).flatMap((tag) => {
    const version = upstreamParts(tag);
    return version === null
      ? []
      : [{ tag, version, nightly: parseUpstreamReleaseTag(tag)?.channel === "nightly" }];
  });
  const selected = tags.toSorted((left, right) => {
    const versionOrder = compareNumbers(right.version, left.version);
    if (versionOrder !== 0) return versionOrder;
    return Number(left.nightly) - Number(right.nightly);
  })[0];
  if (selected === undefined) {
    throw new Error(`upstream base ${baseSha} has no supported release tag`);
  }
  return { tag: selected.tag, sha: baseSha, version: selected.version };
};

interface ReviewedDraft {
  readonly ref: string;
  readonly sha: string;
  readonly targetVersion: string;
  readonly relatesTo: number | null;
  readonly tasks: ReadonlyArray<UatTask>;
}

const oneDraftValue = (body: string, pattern: RegExp, name: string): string => {
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`reviewed draft must contain exactly one ${name}`);
  }
  return matches[0][1];
};

export const reviewedDraft = (body: string): ReviewedDraft => {
  if (/^## Sources\s*$/m.test(body)) {
    throw new Error("reviewed draft still contains ## Sources; remove it before --prepare");
  }
  if (/^## Excluded\s*$/m.test(body)) {
    throw new Error("reviewed draft still contains ## Excluded; remove it before --prepare");
  }
  if (!body.includes("<!-- fork-uat:task-drafts:v1 -->")) {
    throw new Error("reviewed draft has no fork-uat task-drafts marker");
  }
  const tasks = reviewedUatTasks(body);
  const targetVersion = oneDraftValue(body, /^- Target: `([^`]+)`$/gm, "Snapshot Target");
  if (!TARGET_VERSION.test(targetVersion)) {
    throw new Error("reviewed draft Target must match vX.Y.Z-hyprws");
  }
  const ref = oneDraftValue(body, /^- Ref: `([^`]+)`$/gm, "Snapshot Ref");
  const sha = oneDraftValue(body, /^- Commit: `([0-9a-f]{40,64})`$/gm, "Snapshot Commit");
  const relations = [
    ...body.matchAll(/^Related issue: `RSI-Software\/t3code-hyprws#([1-9][0-9]*)`\.$/gm),
  ];
  if (relations.length > 1) throw new Error("reviewed draft contains multiple related issues");
  return {
    ref,
    sha,
    targetVersion,
    relatesTo: relations[0]?.[1] === undefined ? null : Number(relations[0][1]),
    tasks,
  };
};

// `ghb` requires a Source on every agent-mediated filing, and `--human-approved` on every filing
// that claims a human filer. The dry-run publishes nothing, so it carries both to validate the
// draft's shape; the real create earns `--human-approved` from the operator flag of the same name.
const ISSUE_SOURCE = "fork-sync stable-prepare";

const HUMAN_APPROVAL_REQUIRED =
  "--create requires --human-approved: filing as Human needs explicit approval of the exact publication bundle";

const issueCreateArguments = (input: {
  readonly dryRun: boolean;
  readonly title: string;
  readonly body: string;
  readonly type: "Tracker 📡" | "Task 🔨";
  readonly relationship: ReadonlyArray<string>;
}): ReadonlyArray<string> => [
  ...(input.dryRun ? ["--dry-run"] : []),
  "issue",
  "create",
  "--repo",
  REPOSITORY,
  "--title",
  input.title,
  "--body-file",
  input.body,
  "--type",
  input.type,
  "--priority",
  "Medium",
  "--filed-by",
  "Human",
  "--human-approved",
  "--source",
  ISSUE_SOURCE,
  "--label",
  "release",
  "--no-project",
  ...input.relationship,
];

const assertReviewedRef = (
  metadata: Pick<ReviewedDraft, "ref" | "sha">,
  runner: CommandRunner,
): void => {
  if (checkedOutRefIsDirty(runner, metadata.ref)) {
    throw new Error(`ref ${metadata.ref} is the dirty checked-out HEAD`);
  }
  const resolved = requireSuccess(runner, "git", ["rev-parse", `${metadata.ref}^{commit}`]).trim();
  if (resolved !== metadata.sha) {
    throw new Error(`reviewed ref ${metadata.ref} no longer resolves to ${metadata.sha}`);
  }
};

const prepareReviewedDraft = (
  bodyPath: string,
  bundlePath: string | null,
  runner: CommandRunner,
): string => {
  const reviewBody = NodeFS.readFileSync(bodyPath, "utf8");
  const metadata = reviewedDraft(reviewBody);
  assertReviewedRef(metadata, runner);
  const output = bundlePath ?? publicationPath(bodyPath);
  const publication = preparePublication({
    bundlePath: output,
    reviewPath: bodyPath,
    reviewBody,
    ...metadata,
  });
  const parentPath = publicationFilePath(output, publication.parent);
  requireSuccess(
    runner,
    "ghb",
    issueCreateArguments({
      dryRun: true,
      title: publication.parent.title,
      body: parentPath,
      type: "Tracker 📡",
      relationship: relationshipArguments(publication.relatesTo),
    }),
  );
  for (const task of publication.tasks) {
    requireSuccess(
      runner,
      "ghb",
      issueCreateArguments({
        dryRun: true,
        title: task.title,
        body: publicationFilePath(output, task),
        type: "Task 🔨",
        relationship: ["--no-relationship"],
      }),
    );
  }
  sealPublication(output);
  process.stdout.write(
    `${output}\n${publication.parent.title}\n${publication.tasks.map((task) => task.title).join("\n")}\nStop. Show this exact bundle to the human before --create.\n`,
  );
  return output;
};

const createPublication = (bundlePath: string, runner: CommandRunner): string => {
  const publication = readPublication(bundlePath);
  assertReviewedRef(publication, runner);
  const receipts = NodePath.join(bundlePath, "receipts");
  NodeFS.mkdirSync(receipts, { recursive: true });
  const parent = ensureCreated(
    runner,
    NodePath.join(receipts, "parent.json"),
    issueCreateArguments({
      dryRun: false,
      title: publication.parent.title,
      body: publicationFilePath(bundlePath, publication.parent),
      type: "Tracker 📡",
      relationship: relationshipArguments(publication.relatesTo),
    }),
    requireSuccess,
  );
  const children = [];
  let previous: number | null = null;
  for (const [index, task] of publication.tasks.entries()) {
    const child = ensureCreated(
      runner,
      NodePath.join(receipts, `task-${String(index + 1).padStart(2, "0")}.json`),
      issueCreateArguments({
        dryRun: false,
        title: task.title,
        body: publicationFilePath(bundlePath, task),
        type: "Task 🔨",
        relationship: [
          "--no-relationship",
          "--parent",
          `${REPOSITORY}#${parent.number}`,
          ...(previous === null ? ["--first"] : ["--after", `${REPOSITORY}#${previous}`]),
        ],
      }),
      requireSuccess,
    );
    children.push(child);
    previous = child.number;
  }
  process.stdout.write(`${parent.url}\n${children.map((child) => child.url).join("\n")}\n`);
  return parent.url;
};

export const execute = (options: Options, runner: CommandRunner): string => {
  if (options.create) {
    if (options.bundle === null) throw new Error("--create requires --bundle <directory>");
    if (!options.humanApproved) throw new Error(HUMAN_APPROVAL_REQUIRED);
    return createPublication(options.bundle, runner);
  }
  if (options.prepare) {
    if (options.body === null) throw new Error("--prepare requires --body <path>");
    return prepareReviewedDraft(options.body, options.bundle, runner);
  }
  if (checkedOutRefIsDirty(runner, options.ref)) {
    throw new Error(`ref ${options.ref} is the dirty checked-out HEAD`);
  }
  const sha = requireSuccess(runner, "git", ["rev-parse", `${options.ref}^{commit}`]).trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha))
    throw new Error(`${options.ref} did not resolve to a full SHA`);

  const base = upstreamBase(runner, sha);
  const targetVersion = options.version ?? targetVersionFromUpstreamTag(base.tag);
  const tags = lines(requireSuccess(runner, "git", ["tag", "--list", "v*-hyprws.*"]));
  const tagsOnRef = lines(
    requireSuccess(runner, "git", ["tag", "--points-at", sha, "--sort=-v:refname"]),
  );
  const previousStable = resolvePreviousStable(
    runner,
    options.since,
    base.version,
    tags,
    tagsOnRef,
  );
  if (previousStable.tag === null) {
    throw new Error(`no previous stable exists at or below upstream ${base.tag}`);
  }

  verifyFirstParent(runner, sha);
  verifyFirstParent(runner, previousStable.tag);
  const currentLedger = readLedger(runner, sha);
  const previousLedger = readLedger(runner, previousStable.tag);
  const difference = differenceRows(
    currentLedger.commits,
    previousLedger.commits,
    (commitSha) => patchIdFor(runner, commitSha),
    (commitSha) =>
      lines(
        requireSuccess(runner, "git", [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-only",
          "-r",
          commitSha,
        ]),
      ),
  );
  const classified = partitionUatRows(difference, (row) => isUpstreamCommit(runner, row.sha));
  const previousUat = readPreviousUat(runner, previousStable.tag);
  if (classified.rows.length === 0 && previousUat === null) {
    throw new Error("ref difference and previous UAT have no user-facing acceptance conditions");
  }

  const output = options.output ?? `.dump/fork-uat/uat-${targetVersion}.md`;
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  NodeFS.writeFileSync(
    output,
    renderUatBody({
      ref: options.ref,
      sha,
      targetVersion,
      upstreamBaseTag: base.tag,
      upstreamBaseSha: base.sha,
      previousStable: previousStable.tag,
      previousStableOverridden: previousStable.overridden,
      relatesTo: options.relatesTo,
      previousUat,
      sources: classified.rows.map((row) => sourceContext(runner, row)),
      excluded: classified.excluded,
    }),
  );

  process.stdout.write(
    `${output}\n${previousUat === null ? "no previous UAT" : `carried ${previousUat.tasks.length} conditions from #${previousUat.issue}`}\nStop. Review the sources and carried conditions before --prepare.\n`,
  );
  return output;
};

export const run = (
  argv: ReadonlyArray<string>,
  runner: CommandRunner = new SystemRunner(),
): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    execute(parseUatArgs(argv), runner);
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

export { parseUatArgs as parseArgs };

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
