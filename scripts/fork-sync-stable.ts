// @effect-diagnostics nodeBuiltinImport:off - Stable release reports are external operator state.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import type { CwdCommandRunner as CommandRunner } from "./lib/fork-command.ts";
import { parseStableForkTag } from "./lib/fork-policy.ts";
import { resolveNextForkStableTag } from "./fork-release-version.ts";
import {
  commandText,
  externalPath,
  git,
  lines,
  REPOSITORY,
  requireSuccess,
  rootFor,
  worktreePath,
} from "./fork-sync-state.ts";

const RELEASE_LABEL = "release";
const FULL_SHA = /^[0-9a-f]{40,64}$/;

export type StableStage = "stable-listed" | "stable-prepared" | "stable-published";

export interface StableCandidate {
  readonly issue: number;
  readonly name: string;
  readonly title: string;
  readonly body: string;
  readonly branch: string;
}

export interface StableReport {
  readonly schemaVersion: 1;
  readonly stage: StableStage;
  readonly repositoryRoot: string;
  readonly reportPath: string;
  readonly candidates: ReadonlyArray<StableCandidate>;
  readonly selected?: StableCandidate;
  readonly snapshot?: { readonly branch: string; readonly sha: string };
  readonly lane?: { readonly branch: string; readonly worktree: string };
  readonly release?: { readonly tag: string; readonly priorTags: ReadonlyArray<string> };
  readonly uatDraftPath?: string;
  readonly verification: ReadonlyArray<{ readonly command: string; readonly result: string }>;
  readonly workflow?: {
    readonly runId: string;
    readonly url: string;
    readonly assets: ReadonlyArray<string>;
  };
}

const defaultReportPath = (): string =>
  NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-stable-")),
    "report.json",
  );

const candidateFromIssue = (issue: {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}): StableCandidate | null => {
  const titleMatch = /^Stable candidate (v\d+\.\d+\.\d+-hyprws)$/.exec(issue.title);
  if (titleMatch === null) return null;
  const name = titleMatch[1] ?? "";
  if (parseStableForkTag(`${name}.1`) === null) return null;
  const branch = `release/${name}`;
  if (!issue.body.includes(`\`${branch}\``)) {
    throw new Error(`stable candidate issue ${issue.number} does not name snapshot ${branch}`);
  }
  if (!issue.body.includes(`<!-- hyprws-stable-candidate: ${name} -->`)) {
    throw new Error(`stable candidate issue ${issue.number} has no matching snapshot marker`);
  }
  return { issue: issue.number, name, title: issue.title, body: issue.body, branch };
};

const readOpenCandidates = (
  runner: CommandRunner,
  root: string,
): ReadonlyArray<StableCandidate> => {
  const raw = requireSuccess(
    runner,
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      RELEASE_LABEL,
      "--limit",
      "1000",
      "-R",
      REPOSITORY,
      "--json",
      "number,title,body",
    ],
    root,
  );
  const issues = JSON.parse(raw) as ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly body: string;
  }>;
  return issues.flatMap((issue) => {
    const candidate = candidateFromIssue(issue);
    return candidate === null ? [] : [candidate];
  });
};

const readSelectedIssue = (
  runner: CommandRunner,
  root: string,
  selected: StableCandidate,
  requireOpen: boolean,
): StableCandidate => {
  const raw = requireSuccess(
    runner,
    "gh",
    [
      "issue",
      "view",
      String(selected.issue),
      "-R",
      REPOSITORY,
      "--json",
      "number,title,body,state",
    ],
    root,
  );
  const issue = JSON.parse(raw) as {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly state: string;
  };
  if (requireOpen && issue.state !== "OPEN") {
    throw new Error(`stable candidate issue ${selected.issue} is no longer open`);
  }
  const current = candidateFromIssue(issue);
  if (
    current === null ||
    current.issue !== selected.issue ||
    current.title !== selected.title ||
    current.body !== selected.body ||
    current.name !== selected.name ||
    current.branch !== selected.branch
  ) {
    throw new Error(`stable candidate issue ${selected.issue} changed since stable-list`);
  }
  return current;
};

export const validateStableReport = (value: unknown): StableReport => {
  if (typeof value !== "object" || value === null)
    throw new Error("stable report is not an object");
  const report = value as Partial<StableReport>;
  if (
    report.schemaVersion !== 1 ||
    !["stable-listed", "stable-prepared", "stable-published"].includes(report.stage ?? "")
  ) {
    throw new Error("unsupported stable report schema");
  }
  if (
    typeof report.repositoryRoot !== "string" ||
    typeof report.reportPath !== "string" ||
    !Array.isArray(report.candidates) ||
    !Array.isArray(report.verification)
  ) {
    throw new Error("stable report fields are missing");
  }
  if (
    report.snapshot !== undefined &&
    (typeof report.snapshot.branch !== "string" || !FULL_SHA.test(report.snapshot.sha))
  ) {
    throw new Error("stable report snapshot binding is invalid");
  }
  return report as StableReport;
};

const readStableReport = (path: string): StableReport => {
  const report = validateStableReport(JSON.parse(NodeFS.readFileSync(path, "utf8")));
  if (NodePath.resolve(path) !== NodePath.resolve(report.reportPath)) {
    throw new Error("stable report path does not match its binding");
  }
  return report;
};

const writeStableReport = (report: StableReport): void => {
  const temporary = `${report.reportPath}.tmp-${process.pid}`;
  NodeFS.mkdirSync(NodePath.dirname(report.reportPath), { recursive: true });
  NodeFS.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, report.reportPath);
  NodeFS.chmodSync(report.reportPath, 0o600);
};

const requiredValue = (values: ReadonlyMap<string, string>, name: string): string => {
  const value = values.get(name);
  if (value === undefined) throw new UsageError(`${name} is required`);
  return value;
};

const issueNumber = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError("--issue requires a positive issue number");
  return Number(value);
};

const assertRefAbsent = (
  runner: CommandRunner,
  root: string,
  args: ReadonlyArray<string>,
  description: string,
): void => {
  const result = runner.run("git", args, root);
  if (result.status === 1 || result.status === 2) return;
  if (result.status === 0) throw new Error(`${description} already exists`);
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(`could not verify ${description}${detail ? `: ${detail}` : ""}`);
};

const stableList = (
  argv: ReadonlyArray<string>,
  cwd: string,
  runner: CommandRunner,
): StableReport => {
  const { values } = parseArgs(argv, { values: ["--output"] });
  const root = rootFor(runner, cwd);
  requireSuccess(runner, "node", ["scripts/fork-preflight.ts"], root);
  const candidates = readOpenCandidates(runner, root);
  if (candidates.length === 0) throw new Error("no open stable candidate issues found");
  const reportPath = externalPath(root, values.get("--output") ?? defaultReportPath());
  const report: StableReport = {
    schemaVersion: 1,
    stage: "stable-listed",
    repositoryRoot: root,
    reportPath,
    candidates,
    verification: [],
  };
  writeStableReport(report);
  process.stdout.write(
    `${reportPath}\nStop. Ask the human to select one listed stable candidate:\n${candidates
      .map((candidate) => `  #${candidate.issue} ${candidate.name} (${candidate.branch})`)
      .join("\n")}\n`,
  );
  return report;
};

const matchingStableTags = (
  candidate: StableCandidate,
  tags: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const version = parseStableForkTag(`${candidate.name}.1`);
  if (version === null) throw new Error(`invalid stable candidate ${candidate.name}`);
  return tags
    .flatMap((tag) => {
      const parsed = parseStableForkTag(tag);
      return parsed !== null &&
        parsed.major === version.major &&
        parsed.minor === version.minor &&
        parsed.patch === version.patch
        ? [{ tag, revision: parsed.revision }]
        : [];
    })
    .toSorted((left, right) => left.revision - right.revision)
    .map(({ tag }) => tag);
};

const stablePrepare = (
  argv: ReadonlyArray<string>,
  _cwd: string,
  runner: CommandRunner,
): StableReport => {
  const { values } = parseArgs(argv, { values: ["--report", "--issue"] });
  const report = readStableReport(requiredValue(values, "--report"));
  if (report.stage !== "stable-listed") {
    throw new Error(`stable-prepare requires a stable-listed report, got ${report.stage}`);
  }
  const selectedNumber = issueNumber(requiredValue(values, "--issue"));
  const offered = report.candidates.find(({ issue }) => issue === selectedNumber);
  if (offered === undefined) {
    throw new Error(`issue ${selectedNumber} was not offered by stable-list`);
  }
  const root = report.repositoryRoot;
  requireSuccess(runner, "node", ["scripts/fork-preflight.ts"], root);
  const selected = readSelectedIssue(runner, root, offered, true);
  requireSuccess(
    runner,
    "git",
    [
      "fetch",
      "--tags",
      "origin",
      `refs/heads/${selected.branch}:refs/remotes/origin/${selected.branch}`,
    ],
    root,
  );
  const snapshotSha = git(runner, root, ["rev-parse", `origin/${selected.branch}^{commit}`]);
  if (!FULL_SHA.test(snapshotSha))
    throw new Error(`${selected.branch} did not resolve to a full SHA`);

  const laneBranch = `cut/${selected.name}`;
  assertRefAbsent(
    runner,
    root,
    ["show-ref", "--verify", "--quiet", `refs/heads/${laneBranch}`],
    `stable cut lane ${laneBranch}`,
  );
  const lane = {
    branch: laneBranch,
    worktree: worktreePath(
      requireSuccess(
        runner,
        "wt",
        [
          "switch",
          "--create",
          laneBranch,
          "--base",
          `origin/${selected.branch}`,
          "--no-cd",
          "--format",
          "json",
          "--yes",
        ],
        root,
      ),
    ),
  };
  if (git(runner, lane.worktree, ["rev-parse", "HEAD"]) !== snapshotSha) {
    throw new Error("stable cut lane does not match the selected snapshot SHA");
  }

  const checks: ReadonlyArray<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
    [
      { command: "vp", args: ["i"] },
      { command: "vp", args: ["run", "fork:delta", "--check"] },
      { command: "vp", args: ["check"] },
      { command: "vp", args: ["run", "typecheck"] },
      { command: "vp", args: ["run", "test"] },
    ];
  const verification: Array<{ command: string; result: string }> = [];
  for (const check of checks) {
    requireSuccess(runner, check.command, check.args, lane.worktree);
    verification.push({ command: commandText(check.command, check.args), result: "passed" });
  }

  const allTags = lines(git(runner, lane.worktree, ["tag", "--list", "v*-hyprws.*"]));
  const upstreamVersion = selected.name.slice(1, -"-hyprws".length);
  const releaseTag = resolveNextForkStableTag(upstreamVersion, allTags);
  if (releaseTag === null) throw new Error(`could not derive a stable tag for ${selected.name}`);
  const priorTags = matchingStableTags(selected, allTags);
  assertRefAbsent(
    runner,
    lane.worktree,
    ["show-ref", "--verify", "--quiet", `refs/tags/${releaseTag}`],
    `local tag ${releaseTag}`,
  );
  assertRefAbsent(
    runner,
    lane.worktree,
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${releaseTag}`],
    `remote tag ${releaseTag}`,
  );

  const uatDraftPath = NodePath.join(
    NodePath.dirname(report.reportPath),
    `uat-${selected.name}.md`,
  );
  const uatArgs = [
    "run",
    "fork:uat",
    "--ref",
    `origin/${selected.branch}`,
    "--relates-to",
    String(selected.issue),
    "--output",
    uatDraftPath,
  ];
  requireSuccess(runner, "vp", uatArgs, lane.worktree);
  verification.push({ command: commandText("vp", uatArgs), result: "draft rendered" });

  requireSuccess(
    runner,
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `refs/heads/${selected.branch}:refs/remotes/origin/${selected.branch}`,
    ],
    lane.worktree,
  );
  if (
    git(runner, lane.worktree, ["rev-parse", `origin/${selected.branch}^{commit}`]) !== snapshotSha
  ) {
    throw new Error("stable snapshot moved during preparation; start again");
  }
  if (git(runner, lane.worktree, ["rev-parse", "HEAD"]) !== snapshotSha) {
    throw new Error("stable cut lane HEAD changed during preparation");
  }
  if (git(runner, lane.worktree, ["status", "--porcelain"]).length !== 0) {
    throw new Error("stable cut lane is dirty after preparation");
  }

  const next: StableReport = {
    ...report,
    stage: "stable-prepared",
    selected,
    snapshot: { branch: selected.branch, sha: snapshotSha },
    lane,
    release: { tag: releaseTag, priorTags },
    uatDraftPath,
    verification,
  };
  writeStableReport(next);
  process.stdout.write(
    `${next.reportPath}\n${selected.name} #${selected.issue}\n${selected.branch}@${snapshotSha}\n${releaseTag}\n${priorTags.join("\n") || "no prior matching tags"}\n${uatDraftPath}\nStop. Review and create the UAT under the fork-uat judgement boundary, obtain human sign-off, then obtain an explicit go for ${selected.name}.\n`,
  );
  return next;
};

const preparedBindings = (
  report: StableReport,
): {
  readonly selected: StableCandidate;
  readonly snapshot: NonNullable<StableReport["snapshot"]>;
  readonly lane: NonNullable<StableReport["lane"]>;
  readonly release: NonNullable<StableReport["release"]>;
} => {
  if (
    report.selected === undefined ||
    report.snapshot === undefined ||
    report.lane === undefined ||
    report.release === undefined
  ) {
    throw new Error("stable preparation binding is incomplete");
  }
  return {
    selected: report.selected,
    snapshot: report.snapshot,
    lane: report.lane,
    release: report.release,
  };
};

const stablePublish = (
  argv: ReadonlyArray<string>,
  _cwd: string,
  runner: CommandRunner,
): StableReport => {
  const { values } = parseArgs(argv, { values: ["--report", "--go"] });
  const report = readStableReport(requiredValue(values, "--report"));
  if (report.stage !== "stable-prepared") {
    throw new Error(`stable-publish requires a stable-prepared report, got ${report.stage}`);
  }
  const { selected, snapshot, lane, release } = preparedBindings(report);
  const go = requiredValue(values, "--go");
  if (go !== selected.name) {
    throw new Error(`--go must repeat the exact selected candidate ${selected.name}`);
  }
  const root = report.repositoryRoot;
  readSelectedIssue(runner, root, selected, true);
  requireSuccess(
    runner,
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `refs/heads/${snapshot.branch}:refs/remotes/origin/${snapshot.branch}`,
    ],
    lane.worktree,
  );
  if (
    git(runner, lane.worktree, ["rev-parse", `origin/${snapshot.branch}^{commit}`]) !== snapshot.sha
  ) {
    throw new Error("stable snapshot moved after sign-off; start again");
  }
  if (git(runner, lane.worktree, ["rev-parse", "HEAD"]) !== snapshot.sha) {
    throw new Error("prepared stable cut lane HEAD moved after sign-off");
  }
  if (git(runner, lane.worktree, ["status", "--porcelain"]).length !== 0) {
    throw new Error("prepared stable cut lane is dirty");
  }
  assertRefAbsent(
    runner,
    lane.worktree,
    ["show-ref", "--verify", "--quiet", `refs/tags/${release.tag}`],
    `local tag ${release.tag}`,
  );
  assertRefAbsent(
    runner,
    lane.worktree,
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${release.tag}`],
    `remote tag ${release.tag}`,
  );

  git(runner, lane.worktree, [
    "tag",
    "-a",
    release.tag,
    snapshot.sha,
    "-m",
    `T3 Code hyprws ${release.tag.slice(1)}`,
  ]);
  requireSuccess(runner, "git", ["push", "origin", `refs/tags/${release.tag}`], lane.worktree);
  requireSuccess(runner, "wt", ["remove", "-D", lane.branch], root);

  let runId = "";
  const runArgs = [
    "run",
    "list",
    "--workflow",
    "hyprws-release.yml",
    "--event",
    "push",
    "--limit",
    "20",
    "-R",
    REPOSITORY,
    "--json",
    "databaseId,headBranch",
    "--jq",
    `map(select(.headBranch == \"${release.tag}\"))[0].databaseId // empty`,
  ];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    runId = requireSuccess(runner, "gh", runArgs, root).trim();
    if (runId.length > 0) break;
    if (attempt < 11) requireSuccess(runner, "sleep", ["5"], root);
  }
  if (runId.length === 0) throw new Error(`no release workflow run found for ${release.tag}`);
  requireSuccess(runner, "gh", ["run", "watch", runId, "-R", REPOSITORY], root);
  const assets = lines(
    requireSuccess(
      runner,
      "gh",
      [
        "release",
        "view",
        release.tag,
        "-R",
        REPOSITORY,
        "--json",
        "assets",
        "--jq",
        ".assets[].name",
      ],
      root,
    ),
  );
  if (!assets.some((asset) => asset.endsWith(".AppImage"))) {
    throw new Error(`release ${release.tag} has no .AppImage asset`);
  }
  if (!assets.includes("latest-linux.yml")) {
    throw new Error(`release ${release.tag} has no latest-linux.yml asset`);
  }
  const url = requireSuccess(
    runner,
    "gh",
    ["run", "view", runId, "-R", REPOSITORY, "--json", "url", "--jq", ".url"],
    root,
  ).trim();
  if (url.length === 0) throw new Error(`release workflow ${runId} has no URL`);
  requireSuccess(
    runner,
    "gh",
    [
      "issue",
      "close",
      String(selected.issue),
      "-R",
      REPOSITORY,
      "--comment",
      `Released \`${release.tag}\` from \`${snapshot.branch}@${snapshot.sha}\`. Workflow: ${url}`,
    ],
    root,
  );

  const next: StableReport = {
    ...report,
    stage: "stable-published",
    workflow: { runId, url, assets },
  };
  writeStableReport(next);
  process.stdout.write(
    `published: ${release.tag} from ${snapshot.branch}@${snapshot.sha}\n${url}\n`,
  );
  return next;
};

export const executeStable = (
  argv: ReadonlyArray<string>,
  cwd: string,
  runner: CommandRunner,
): StableReport => {
  const verb = argv[0];
  if (verb === "stable-list") return stableList(argv.slice(1), cwd, runner);
  if (verb === "stable-prepare") return stablePrepare(argv.slice(1), cwd, runner);
  if (verb === "stable-publish") return stablePublish(argv.slice(1), cwd, runner);
  throw new UsageError(`unknown stable verb: ${verb ?? ""}`);
};
