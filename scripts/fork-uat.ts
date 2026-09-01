#!/usr/bin/env node
// Fork UAT history rules:
// Stable tags are not ancestry boundaries because the fork stack is rebased.
// Choose the highest vX.Y.Z-hyprws.N at or below the ref's upstream X.Y.Z version.
// When the ref itself carries a stable tag, choose the next lower eligible stable tag instead.
// Inventory both snapshots against upstream/main; match subjects, then stable patch IDs.

// @effect-diagnostics nodeBuiltinImport:off - This standalone operator script runs before an Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { UsageError } from "./lib/fork-cli.ts";
import {
  SystemInputCommandRunner as SystemRunner,
  type CommandResult,
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
  selectPreviousStable,
  targetVersionFromUpstreamTag,
  uatTitle,
  upstreamParts,
  type DifferenceRow,
  type ExcludedRow,
  type ForkCommit,
  type ForkLedger,
  type UatBodyInput,
  type Version,
} from "./fork-uat-policy.ts";

export {
  differenceRows,
  exclusionReason,
  partitionUatRows,
  relationshipArguments,
  renderUatBody,
  selectPreviousStable,
  targetVersionFromUpstreamTag,
  uatTitle,
  type DifferenceRow,
  type ExcludedRow,
  type ExclusionReason,
  type ForkCommit,
  type UatBodyInput,
} from "./fork-uat-policy.ts";

export { UsageError } from "./lib/fork-cli.ts";

export interface Options {
  readonly ref: string;
  readonly version: string | null;
  readonly since: string | null;
  readonly relatesTo: number | null;
  readonly output: string | null;
  readonly body: string | null;
  readonly create: boolean;
}

const HELP = `Usage: vp run fork:uat [--ref <ref>] [--version <version>] [--since <stable-tag>] [--relates-to <issue>] [--output <path>] [--dry-run]
       vp run fork:uat --create --body <reviewed-path>

Render and preflight a human UAT issue for the fork changes at one Git ref.

Options:
  --ref <ref>           Ref to evaluate (default hyprws).
  --version <version>   Target version (default vX.Y.Z-hyprws from the upstream base).
  --since <stable-tag>  Override the previous stable tag used for comparison.
  --relates-to <issue>  Relate the UAT issue to repository issue N.
  --output <path>       Draft path (default .dump/fork-uat/uat-<version>.md).
  --dry-run             Run ghb's publishing preflight only (default).
  --create              Create from an edited, reviewed draft; requires --body.
  --body <path>         Reviewed draft to post as-is with --create.
  -h, --help            Show this help.
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
  let create = false;
  let mode: "dry-run" | "create" | null = null;
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
    } else if (argument === "--create" || argument === "--dry-run") {
      const requested = argument.slice(2) as "dry-run" | "create";
      if (mode !== null && mode !== requested) {
        throw new UsageError("choose only one of --dry-run or --create");
      }
      mode = requested;
      create = requested === "create";
    } else {
      throw new UsageError(`unknown argument ${argument ?? ""}`);
    }
  }
  if (create && body === null) throw new UsageError("--create requires --body <path>");
  if (!create && body !== null) throw new UsageError("--body requires --create");
  if (create && hasRenderOptions) {
    throw new UsageError("--create --body uses draft metadata; omit render options");
  }
  return { ref, version, since, relatesTo, output, body, create };
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
  const start = output.search(/^\{/m);
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
    throw new Error("reviewed draft still contains ## Sources; remove it before --create");
  }
  if (/^## Excluded\s*$/m.test(body)) {
    throw new Error("reviewed draft still contains ## Excluded; remove it before --create");
  }
  const uatHeading = /^## UAT\s*$/m.exec(body);
  const afterHeading =
    uatHeading === null ? "" : body.slice(uatHeading.index + uatHeading[0].length);
  const nextHeading = /^## /m.exec(afterHeading);
  const uat = nextHeading === null ? afterHeading : afterHeading.slice(0, nextHeading.index);
  if (!/^- \[ \] .+$/m.test(uat)) throw new Error("reviewed draft has no unchecked UAT rows");
  if (!/^### .+$/m.test(uat)) throw new Error("reviewed draft UAT rows have no feature heading");
  const targetVersion = oneDraftValue(body, /^\- Target: `([^`]+)`$/gm, "Snapshot Target");
  if (!TARGET_VERSION.test(targetVersion)) {
    throw new Error("reviewed draft Target must match vX.Y.Z-hyprws");
  }
  const ref = oneDraftValue(body, /^\- Ref: `([^`]+)`$/gm, "Snapshot Ref");
  const sha = oneDraftValue(body, /^\- Commit: `([0-9a-f]{40,64})`$/gm, "Snapshot Commit");
  const relations = [
    ...body.matchAll(/^Related issue: `RSI-Software\/t3code-hyprws#([1-9][0-9]*)`\.$/gm),
  ];
  if (relations.length > 1) throw new Error("reviewed draft contains multiple related issues");
  return {
    ref,
    sha,
    targetVersion,
    relatesTo: relations[0]?.[1] === undefined ? null : Number(relations[0][1]),
  };
};

const issueCreateArguments = (
  dryRun: boolean,
  title: string,
  body: string,
  relatesTo: number | null,
): ReadonlyArray<string> => [
  ...(dryRun ? ["--dry-run"] : []),
  "issue",
  "create",
  "--repo",
  REPOSITORY,
  "--title",
  title,
  "--body-file",
  body,
  "--type",
  "Task 🔨",
  "--priority",
  "Medium",
  "--filed-by",
  "Human",
  "--label",
  "release",
  "--no-project",
  ...relationshipArguments(relatesTo),
];

const executeReviewedCreate = (bodyPath: string, runner: CommandRunner): string => {
  const metadata = reviewedDraft(NodeFS.readFileSync(bodyPath, "utf8"));
  if (checkedOutRefIsDirty(runner, metadata.ref)) {
    throw new Error(`ref ${metadata.ref} is the dirty checked-out HEAD`);
  }
  const resolved = requireSuccess(runner, "git", ["rev-parse", `${metadata.ref}^{commit}`]).trim();
  if (resolved !== metadata.sha) {
    throw new Error(`reviewed ref ${metadata.ref} no longer resolves to ${metadata.sha}`);
  }
  const createArgs = issueCreateArguments(
    false,
    uatTitle(metadata.targetVersion),
    bodyPath,
    metadata.relatesTo,
  );
  const exactCommand = commandText("ghb", createArgs);
  process.stdout.write(`${bodyPath}\n${exactCommand}\n`);
  requireSuccess(runner, "ghb", createArgs);
  return exactCommand;
};

export const execute = (options: Options, runner: CommandRunner): string => {
  if (options.create) {
    if (options.body === null) throw new Error("--create requires --body <path>");
    return executeReviewedCreate(options.body, runner);
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
  if (classified.rows.length === 0) throw new Error("ref difference has no user-facing UAT rows");

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
      sources: classified.rows.map((row) => sourceContext(runner, row)),
      excluded: classified.excluded,
    }),
  );

  const createArgs = issueCreateArguments(true, uatTitle(targetVersion), output, options.relatesTo);
  const exactCommand = commandText("ghb", createArgs);
  process.stdout.write(`${output}\n${exactCommand}\n`);
  requireSuccess(runner, "ghb", createArgs);
  return exactCommand;
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
