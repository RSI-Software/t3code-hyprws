#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Operator state machine runs before Effect exists.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { UsageError } from "./lib/fork-cli.ts";
import {
  SystemCommandRunner as SystemRunner,
  type CommandResult,
  type CwdCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";

export {
  SystemCommandRunner as SystemRunner,
  type CommandResult,
  type CwdCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";
import {
  FORK_REPOSITORY,
  HYPRWS_REF,
  isNightlyUpstreamTag,
  positionUpstreamReleaseTags,
  selectNewestReleaseTag,
} from "./lib/fork-policy.ts";
import { parseForkTrailers } from "./lib/fork-trailers.ts";

import { executeStable } from "./fork-sync-stable.ts";
import {
  assertOnly,
  BLOCK_LABEL,
  commandText,
  COMMENT_CONFIG,
  externalPath,
  extractBlockingSha,
  git,
  gitRaw,
  lines,
  oneValue,
  orientationDecisionRows,
  orientationTouchedPaths,
  parseConflictRows,
  parseVerbArgs,
  readReport,
  REPOSITORY,
  requireSuccess,
  rootFor,
  SYNC_HELP,
  writeRecord,
  writeReport,
  worktreePath,
  type ConflictRow,
  type SyncReport,
} from "./fork-sync-state.ts";

export {
  orientationDecisionRows,
  orientationTouchedPaths,
  parseConflictRows,
  renderRecord,
  validateReport,
  type ConflictClass,
  type ConflictRow,
  type SyncReport,
  type SyncStage,
} from "./fork-sync-state.ts";

const readIssue = (
  runner: CommandRunner,
  root: string,
): { number: number; title: string; body: string } => {
  const raw = requireSuccess(
    runner,
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      BLOCK_LABEL,
      "-R",
      REPOSITORY,
      "--json",
      "number,title,body",
    ],
    root,
  );
  const issues = JSON.parse(raw) as ReadonlyArray<{ number: number; title: string; body: string }>;
  if (issues.length !== 1)
    throw new Error(`expected exactly one open ${BLOCK_LABEL} issue, found ${issues.length}`);
  const issue = issues[0];
  if (issue === undefined) throw new Error("blocked issue disappeared");
  requireSuccess(
    runner,
    "gh",
    ["issue", "view", String(issue.number), "--comments", "-R", REPOSITORY],
    root,
  );
  return issue;
};

const releaseTags = (
  runner: CommandRunner,
  root: string,
  blockingSha: string,
): ReadonlyArray<{ tag: string; sha: string }> => {
  const firstParentShas = lines(
    git(runner, root, ["rev-list", "--first-parent", "--reverse", "upstream/main"]),
  );
  const blockingPosition = firstParentShas.indexOf(blockingSha);
  if (blockingPosition === -1) return [];
  const tags = positionUpstreamReleaseTags(
    { run: (args) => git(runner, root, args) },
    firstParentShas,
  ).filter(({ position }) => position >= blockingPosition);
  return tags
    .toSorted((left, right) => {
      const newest = selectNewestReleaseTag([left, right]);
      return newest === left ? -1 : 1;
    })
    .map(({ tag, sha }) => ({ tag, sha }));
};

const defaultReportPath = (): string =>
  NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-")), "report.json");

const unblockList = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--output"]);
  const root = rootFor(runner, cwd);
  requireSuccess(runner, "node", ["scripts/fork-preflight.ts"], root);
  const issue = readIssue(runner, root);
  const blockingSha = extractBlockingSha(issue.body);
  if (blockingSha === null)
    throw new Error(`blocked issue ${issue.number} has no full blocking-sha marker`);
  requireSuccess(runner, "node", ["scripts/fork-upstream-watch.ts"], root);
  const candidates = releaseTags(runner, root, blockingSha);
  if (candidates.length === 0)
    throw new Error(`no upstream release tag contains blocking commit ${blockingSha}`);
  const reportPath = externalPath(root, values.get("--output") ?? defaultReportPath());
  const report: SyncReport = {
    schemaVersion: 1,
    stage: "listed",
    repositoryRoot: root,
    reportPath,
    recordPath: NodePath.join(NodePath.dirname(reportPath), "record.md"),
    issue: { number: issue.number, blockingSha, title: issue.title },
    candidates,
    conflicts: [],
    verification: [],
  };
  writeReport(report);
  writeRecord(report);
  process.stdout.write(
    `${reportPath}\nStop. Ask the human to select one listed target:\n${candidates.map(({ tag, sha }) => `  ${tag}@${sha}`).join("\n")}\n`,
  );
  return report;
};

const unblockOrient = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report", "--target"]);
  const report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage !== "listed")
    throw new Error(`unblock-orient requires a listed report, got ${report.stage}`);
  const targetTag = oneValue(values, "--target") ?? "";
  const offered = report.candidates.find(({ tag }) => tag === targetTag);
  if (offered === undefined) throw new Error(`target ${targetTag} was not offered by unblock-list`);
  const root = report.repositoryRoot;
  requireSuccess(runner, "node", ["scripts/fork-preflight.ts"], root);
  const issue = readIssue(runner, root);
  if (
    issue.number !== report.issue.number ||
    extractBlockingSha(issue.body) !== report.issue.blockingSha
  )
    throw new Error("blocked issue changed since unblock-list; start again");
  const liveTarget = git(runner, root, ["rev-parse", `refs/tags/${targetTag}^{commit}`]);
  if (liveTarget !== offered.sha) throw new Error(`target ${targetTag} moved since unblock-list`);
  const expectedOld = git(runner, root, ["rev-parse", "origin/hyprws^{commit}"]);
  const sharedBase = git(runner, root, ["merge-base", expectedOld, liveTarget]);
  const orientation = requireSuccess(
    runner,
    "node",
    ["scripts/fork-orient.ts", "--target", targetTag],
    root,
  );
  const next: SyncReport = {
    ...report,
    stage: "oriented",
    target: { tag: targetTag, sha: liveTarget },
    source: { sha: expectedOld, expectedOld, sharedBase },
    orientation,
    touchedPaths: orientationTouchedPaths(orientation),
    conflicts: orientationDecisionRows(orientation),
  };
  writeReport(next);
  writeRecord(next);
  process.stdout.write(`${next.reportPath}\n${orientation}\n`);
  return next;
};

const replayMessages = (runner: CommandRunner, cwd: string, range: string): string =>
  gitRaw(runner, cwd, ["log", "--reverse", "--topo-order", "--format=%B%x1e", range], true);
const currentCommit = (
  runner: CommandRunner,
  cwd: string,
): { sha: string; subject: string; domain: string } => {
  const raw = git(runner, cwd, ["show", "-s", "--format=%H%x1f%s%x1f%b", "REBASE_HEAD"], true);
  const [sha = "", subject = "", body = ""] = raw.split("\x1f");
  return { sha, subject, domain: parseForkTrailers(body).domain ?? "?" };
};

const pendingConflicts = (runner: CommandRunner, cwd: string): ReadonlyArray<string> =>
  lines(git(runner, cwd, ["diff", "--name-only", "--diff-filter=U"], true));

export const rehearsalConflictStop = (
  reportPath: string,
  recordPath: string,
  commit: { readonly sha: string; readonly subject: string },
  conflicts: ReadonlyArray<string>,
): string =>
  [
    reportPath,
    `Stop. Rebase conflict in ${commit.subject} (${commit.sha.slice(0, 12)}).`,
    "Conflicted paths:",
    ...conflicts.map((path) => `  - ${path}`),
    `Resolve and stage non-generated files, complete every TODO row in ${recordPath}, then rerun unblock-rehearse.`,
    "",
  ].join("\n");

const verifyReplay = (report: SyncReport, runner: CommandRunner): void => {
  if (
    report.target === undefined ||
    report.originalMessages === undefined ||
    report.originalCount === undefined ||
    report.lane === undefined
  )
    throw new Error("replay binding is incomplete");
  const count = Number(
    git(runner, report.lane.worktree, ["rev-list", "--count", `${report.target.sha}..HEAD`], true),
  );
  if (count !== report.originalCount)
    throw new Error(`replay commit count changed: ${report.originalCount} -> ${count}`);
  const messages = replayMessages(runner, report.lane.worktree, `${report.target.sha}..HEAD`);
  if (messages !== report.originalMessages) throw new Error("replay commit messages changed");
};

const unblockRehearse = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report"]);
  let report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage === "oriented") {
    if (report.target === undefined || report.source === undefined)
      throw new Error("orientation binding is incomplete");
    const target = report.target;
    const source = report.source;
    requireSuccess(runner, "node", ["scripts/fork-preflight.ts"], report.repositoryRoot);
    const live = git(runner, report.repositoryRoot, ["rev-parse", "origin/hyprws^{commit}"]);
    if (live !== source.expectedOld)
      throw new Error("origin/hyprws moved after orientation; start a new rehearsal");
    const branch = `rehearse/${target.tag}-from-${source.expectedOld.slice(0, 12)}`;
    if (
      runner.run(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        report.repositoryRoot,
      ).status === 0
    )
      throw new Error(`rehearsal lane already exists: ${branch}; inspect it instead of colliding`);
    const originalMessages = replayMessages(
      runner,
      report.repositoryRoot,
      `${source.sharedBase}..${source.expectedOld}`,
    );
    const originalCount = Number(
      git(
        runner,
        report.repositoryRoot,
        ["rev-list", "--count", `${source.sharedBase}..${source.expectedOld}`],
        true,
      ),
    );
    const worktree = worktreePath(
      requireSuccess(
        runner,
        "wt",
        [
          "switch",
          "--create",
          branch,
          "--base",
          source.expectedOld,
          "--no-cd",
          "--format",
          "json",
          "--yes",
        ],
        report.repositoryRoot,
      ),
    );
    requireSuccess(runner, "vp", ["i"], worktree);
    git(runner, worktree, ["restore", "--source=HEAD", "--worktree", "--", "pnpm-lock.yaml"], true);
    report = { ...report, lane: { branch, worktree }, originalMessages, originalCount };
    const rebase = runner.run(
      "git",
      ["-c", "core.commentChar=auto", "rebase", target.sha],
      worktree,
      undefined,
      { ...process.env, ...COMMENT_CONFIG, GIT_EDITOR: "true" },
    );
    if (rebase.status !== 0 && pendingConflicts(runner, worktree).length === 0)
      throw new Error(`git rebase failed without conflicts: ${rebase.stderr.trim()}`);
  } else if (report.stage === "conflicts") {
    if (report.lane === undefined) throw new Error("rehearsal lane is missing");
    const lane = report.lane;
    const recordRows = parseConflictRows(NodeFS.readFileSync(report.recordPath, "utf8"));
    const pending = report.conflicts.filter(
      (row) =>
        row.resolution === "TODO" ||
        row.agentSafe === "TODO" ||
        row.agentSafe === "pending regeneration",
    );
    for (const row of pending.filter(({ class: klass }) => klass !== "generated")) {
      const edited = recordRows.find(
        (candidate) => candidate.path === row.path && candidate.subject === row.subject,
      );
      if (
        edited === undefined ||
        edited.class === "TODO" ||
        edited.resolution === "TODO" ||
        edited.agentSafe === "TODO"
      )
        throw new Error(`record row remains incomplete for ${row.path}`);
    }
    const staged = new Set(
      lines(git(runner, lane.worktree, ["diff", "--cached", "--name-only"], true)),
    );
    for (const row of pending.filter(({ path }) => path !== "pnpm-lock.yaml"))
      if (!staged.has(row.path)) throw new Error(`resolved conflict is not staged: ${row.path}`);
    if (pending.some(({ path }) => path === "pnpm-lock.yaml")) {
      git(
        runner,
        lane.worktree,
        ["restore", "--source=HEAD", "--staged", "--worktree", "--", "pnpm-lock.yaml"],
        true,
      );
      requireSuccess(runner, "vp", ["install", "--lockfile-only"], lane.worktree);
      git(runner, lane.worktree, ["add", "pnpm-lock.yaml"], true);
    }
    report = {
      ...report,
      conflicts: report.conflicts.map((row) => {
        if (pending.includes(row) && row.class === "generated")
          return { ...row, agentSafe: "yes — regenerated by unblock-rehearse" };
        return (
          recordRows.find((edited) => edited.path === row.path && edited.subject === row.subject) ??
          row
        );
      }),
    };
    const continued = runner.run(
      "git",
      ["-c", "core.commentChar=auto", "rebase", "--continue"],
      lane.worktree,
      undefined,
      { ...process.env, ...COMMENT_CONFIG, GIT_EDITOR: "true" },
    );
    if (continued.status !== 0 && pendingConflicts(runner, lane.worktree).length === 0)
      throw new Error(`git rebase --continue failed without conflicts: ${continued.stderr.trim()}`);
  } else
    throw new Error(`unblock-rehearse requires oriented or conflicts state, got ${report.stage}`);

  if (report.lane === undefined) throw new Error("rehearsal lane is missing");
  const conflicts = pendingConflicts(runner, report.lane.worktree);
  if (conflicts.length > 0) {
    const commit = currentCommit(runner, report.lane.worktree);
    const additions = conflicts.map(
      (path): ConflictRow => ({
        ...commit,
        commit: commit.sha,
        path,
        class: path === "pnpm-lock.yaml" ? "generated" : "TODO",
        resolution: path === "pnpm-lock.yaml" ? "restore HEAD and regenerate" : "TODO",
        agentSafe: path === "pnpm-lock.yaml" ? "pending regeneration" : "TODO",
      }),
    );
    report = { ...report, stage: "conflicts", conflicts: [...report.conflicts, ...additions] };
    writeReport(report);
    writeRecord(report);
    process.stdout.write(
      rehearsalConflictStop(report.reportPath, report.recordPath, commit, conflicts),
    );
    return report;
  }
  verifyReplay(report, runner);
  const rebasedHead = git(runner, report.lane.worktree, ["rev-parse", "HEAD"], true);
  const stackSize = Number(
    git(
      runner,
      report.lane.worktree,
      ["rev-list", "--count", `${report.target?.sha ?? ""}..HEAD`],
      true,
    ),
  );
  report = { ...report, stage: "replayed", rebasedHead, stackSize };
  writeReport(report);
  writeRecord(report);
  process.stdout.write(
    `${report.reportPath}\nStop. Replay complete; review conflict rows before unblock-check.\n`,
  );
  return report;
};

const section = (text: string, heading: string): string => {
  const start = text.indexOf(`${heading}\n`);
  if (start === -1) return "";
  const rest = text.slice(start + heading.length + 1);
  const next = /^\S[^:\n]*:\s*$/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
};

export const lockDriftClass = (
  before: string,
  after: string,
): "none" | "importers" | "snapshots" => {
  if (before === after) return "none";
  return section(before, "importers:") === section(after, "importers:") ? "snapshots" : "importers";
};

const readHeadFile = (runner: CommandRunner, cwd: string, path: string): string =>
  gitRaw(runner, cwd, ["show", `HEAD:${path}`], true);
const restoreSnapshotDrift = (runner: CommandRunner, cwd: string): void => {
  git(runner, cwd, ["restore", "--source=HEAD", "--worktree", "--", "pnpm-lock.yaml"], true);
};

const unblockCheck = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report"]);
  let report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage !== "replayed")
    throw new Error(`unblock-check requires replayed state, got ${report.stage}`);
  if (report.lane === undefined || report.target === undefined)
    throw new Error("replay binding is incomplete");
  verifyReplay(report, runner);
  const worktree = report.lane.worktree;
  const before = readHeadFile(runner, worktree, "pnpm-lock.yaml");
  requireSuccess(runner, "vp", ["install", "--lockfile-only"], worktree);
  const after = NodeFS.readFileSync(NodePath.join(worktree, "pnpm-lock.yaml"), "utf8");
  const drift = lockDriftClass(before, after);
  if (drift === "importers") {
    const owners = lines(
      git(
        runner,
        worktree,
        [
          "log",
          "--format=%s",
          `${report.target.sha}..HEAD`,
          "--",
          "package.json",
          ":(glob)**/package.json",
        ],
        true,
      ),
    );
    throw new Error(
      `pnpm-lock.yaml importer drift must be folded into its manifest-owning fork commit; candidates: ${owners.join(" | ") || "none"}`,
    );
  }
  if (drift === "snapshots") restoreSnapshotDrift(runner, worktree);
  requireSuccess(runner, "vp", ["i"], worktree);
  const installedAfter = NodeFS.readFileSync(NodePath.join(worktree, "pnpm-lock.yaml"), "utf8");
  if (lockDriftClass(before, installedAfter) === "importers")
    throw new Error("vp i introduced importer drift after replay");
  if (installedAfter !== before) restoreSnapshotDrift(runner, worktree);
  const installedHead = git(runner, worktree, ["rev-parse", "HEAD"], true);
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [
    { command: "vp", args: ["run", "fork:scan", "--target", report.target.tag] },
    { command: "vp", args: ["run", "fork:delta", "--check"] },
    { command: "vp", args: ["check"] },
    { command: "vp", args: ["run", "typecheck"] },
    { command: "vp", args: ["run", "test"] },
  ];
  const verification: Array<{ command: string; result: string }> = [];
  for (const command of commands) {
    requireSuccess(runner, command.command, command.args, worktree);
    verification.push({ command: commandText(command.command, command.args), result: "passed" });
  }
  if (git(runner, worktree, ["rev-parse", "HEAD"], true) !== installedHead)
    throw new Error("HEAD changed after the installed-tree check");
  report = { ...report, stage: "checked", installedHead, verification };
  writeReport(report);
  writeRecord(report);
  process.stdout.write(
    `${report.reportPath}\n${decisionSurface(NodeFS.readFileSync(report.recordPath, "utf8"))}`,
  );
  return report;
};

export const decisionSurface = (record: string): string => {
  const rows = record.split("\n").filter((line) => {
    if (!/^\| `.+` \|/.test(line)) return false;
    const classSummary = line.split("|")[3] ?? "";
    return /\b(?:retire-candidate|human)\b/.test(classSummary);
  });
  const grounding = record.split("\n").filter((line) => /^Grounding (?:claim|pending):/.test(line));
  return [
    "## Gate 4 decision surface",
    ...rows,
    ...grounding,
    "Stop. Obtain every decision, grounding confirmation, login/date, and explicit go.",
    "",
  ].join("\n");
};

export const validateSignedRecord = (record: string, report: SyncReport): void => {
  const sanity = /^- Human sanity: ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})) (\d{4}-\d{2}-\d{2})$/m.exec(
    record,
  );
  if (sanity === null || Number.isNaN(new Date(`${sanity[2]}T00:00:00Z`).valueOf()))
    throw new Error("record is missing Human sanity: <login> YYYY-MM-DD");
  if (/^Grounding pending:/m.test(record)) throw new Error("record still has pending grounding");
  for (const line of decisionSurface(record)
    .split("\n")
    .filter((row) => row.startsWith("|"))) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (!["keep", "retire", "partial"].includes(cells[4] ?? ""))
      throw new Error(`decision row has no keep/retire/partial action: ${line}`);
  }
  if (report.installedHead === undefined) throw new Error("report has no checked installed head");
};

const unblockApply = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report", "--record"]);
  let report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage !== "checked")
    throw new Error(`unblock-apply requires checked state, got ${report.stage}`);
  const recordPath = NodePath.resolve(oneValue(values, "--record") ?? "");
  if (recordPath !== NodePath.resolve(report.recordPath))
    throw new Error("record path does not match the report binding");
  const record = NodeFS.readFileSync(recordPath, "utf8");
  validateSignedRecord(record, report);
  if (report.lane === undefined || report.target === undefined || report.source === undefined)
    throw new Error("apply binding is incomplete");
  const lane = report.lane;
  const target = report.target;
  const source = report.source;
  const worktree = lane.worktree;
  if (git(runner, worktree, ["rev-parse", "HEAD"], true) !== report.installedHead)
    throw new Error("checked rehearsal head moved; rerun unblock-check");
  requireSuccess(runner, "vp", ["run", "fork:upstream-refs", recordPath], worktree);
  const gateArgs = [
    "run",
    "fork:sync-gate",
    "--tag",
    target.tag,
    "--record",
    recordPath,
    ...(isNightlyUpstreamTag(target.tag) ? ["--allow-nightly"] : []),
  ];
  requireSuccess(runner, "vp", gateArgs, worktree);
  const recordCommentUrl = requireSuccess(
    runner,
    "gh",
    ["issue", "comment", String(report.issue.number), "-R", REPOSITORY, "--body-file", recordPath],
    worktree,
  ).trim();
  const push = runner.run(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "push",
      `--force-with-lease=${HYPRWS_REF}:${source.expectedOld}`,
      "origin",
      `HEAD:${HYPRWS_REF}`,
    ],
    worktree,
    undefined,
    { ...process.env, ...COMMENT_CONFIG },
  );
  if (push.status !== 0)
    throw new Error(`leased apply refused; this report cannot be refreshed: ${push.stderr.trim()}`);
  requireSuccess(
    runner,
    "gh",
    [
      "issue",
      "comment",
      String(report.issue.number),
      "-R",
      REPOSITORY,
      "--body",
      `Resolved blocking upstream commit \`${report.issue.blockingSha}\` while rebasing \`hyprws\` onto \`${target.tag}\`; the leased rewrite replaced \`${source.expectedOld}\`. Rehearsal record: ${recordCommentUrl}`,
    ],
    worktree,
  );
  report = { ...report, stage: "applied", recordCommentUrl };
  writeReport(report);
  process.stdout.write(`applied: ${target.tag} with lease ${source.expectedOld}\n`);
  return report;
};

export const execute = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  runner: CommandRunner = new SystemRunner(),
): SyncReport => {
  if (argv[0]?.startsWith("stable-"))
    return executeStable(argv, cwd, runner) as unknown as SyncReport;
  const { verb, values } = parseVerbArgs(argv);
  if (verb === "unblock-list") return unblockList(values, cwd, runner);
  if (verb === "unblock-orient") return unblockOrient(values, cwd, runner);
  if (verb === "unblock-rehearse") return unblockRehearse(values, cwd, runner);
  if (verb === "unblock-check") return unblockCheck(values, cwd, runner);
  if (verb === "unblock-apply") return unblockApply(values, cwd, runner);
  throw new UsageError(`unknown verb: ${verb}`);
};

export const run = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  runner: CommandRunner = new SystemRunner(),
): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(SYNC_HELP);
    return 0;
  }
  try {
    execute(argv, cwd, runner);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    process.stderr.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
