// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { commandText, type CwdCommandRunner as CommandRunner } from "./fork-command.ts";

/**
 * In-lane repair, run once inside the walk and before anything reaches trunk.
 *
 * The lane repairs what a replay predictably breaks — formatting, a moved type, a test whose
 * fixture moved — and nothing else. It deliberately is not a full battery: the full suite is trunk
 * CI's job after the apply, and running it in the lane is what used to cost the walk a CI round
 * trip it could not act on. See the header of `fork-sync-ci.ts` for why the battery lives there.
 */
export const WORKSPACE_ROOTS = ["apps", "packages", "infra"] as const;

const ROOT_PACKAGES = ["scripts", "oxlint-plugin-t3code"] as const;

/** The workspace directories a set of replayed paths touches, in stable order. */
export const touchedWorkspaces = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const found = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    const first = segments[0] ?? "";
    if ((WORKSPACE_ROOTS as ReadonlyArray<string>).includes(first) && segments.length > 1)
      found.add(`${first}/${segments[1]}`);
    else if ((ROOT_PACKAGES as ReadonlyArray<string>).includes(first)) found.add(first);
  }
  return [...found].sort();
};

const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".fork.test.ts", ".fork.test.tsx"] as const;

const isTestPath = (path: string): boolean => TEST_SUFFIXES.some((suffix) => path.endsWith(suffix));

/**
 * A touched test file is its own focus. A touched source file focuses the sibling suites that
 * exist beside it, including the fork-owned sibling the authoring guard requires.
 */
export const focusedTests = (
  root: string,
  paths: ReadonlyArray<string>,
  exists: (path: string) => boolean = (path) => NodeFS.existsSync(NodePath.join(root, path)),
): ReadonlyArray<string> => {
  const found = new Set<string>();
  for (const path of paths) {
    if (isTestPath(path)) {
      if (exists(path)) found.add(path);
      continue;
    }
    const match = /^(.*)\.(?:ts|tsx)$/.exec(path);
    if (match === null) continue;
    const stem = match[1] ?? "";
    for (const suffix of TEST_SUFFIXES) {
      const candidate = `${stem}${suffix}`;
      if (exists(candidate)) found.add(candidate);
    }
  }
  return [...found].sort();
};

const VERIFIABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"] as const;

/**
 * Whether the lane's read-only half can say anything about this path. Verification is a workspace
 * typecheck plus the sibling suites, so a root config file, a workflow, a doc, or a skill gets no
 * check at all. A resolution that invents text in one of those has nothing standing behind it.
 */
export const isVerifiablePath = (path: string): boolean =>
  touchedWorkspaces([path]).length > 0 &&
  VERIFIABLE_EXTENSIONS.some((extension) => path.endsWith(extension));

export interface RepairCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Where the command runs, relative to the lane root. A workspace's test config is its own —
   * `apps/web` is the workspace that teaches Vite about `.wasm` assets — so a suite invoked from
   * the lane root loads a different config than the one its authors wrote it against and fails on
   * a transform nobody broke.
   */
  readonly cwd?: string;
}

/**
 * Formatting is repaired where the resolution was made, so the fix lands in the replayed commit
 * rather than as a dirty worktree the rebase would refuse. It is scoped to the resolved paths for
 * the same reason: a repository-wide reformat mid-rebase is unstageable drift.
 */
export const formatCommand = (paths: ReadonlyArray<string>): RepairCommand | null =>
  paths.length === 0
    ? null
    : { command: "vp", args: ["fmt", "--no-error-on-unmatched-pattern", ...[...paths].sort()] };

/**
 * The read-only half, run once on the finished replay: typecheck scoped to the workspaces the
 * replay touched, and the suites that sit beside the touched files, each run from its own
 * workspace so it gets the test config its authors wrote it against. Nothing here writes, so it
 * cannot dirty the lane it is verifying.
 */
export const verifyPlan = (
  root: string,
  paths: ReadonlyArray<string>,
  exists?: (path: string) => boolean,
): ReadonlyArray<RepairCommand> => {
  const plan: Array<RepairCommand> = [];
  for (const workspace of touchedWorkspaces(paths))
    plan.push({ command: "vp", args: ["run", "--filter", `./${workspace}`, "typecheck"] });
  const byWorkspace = new Map<string, Array<string>>();
  for (const test of focusedTests(root, paths, exists)) {
    const workspace = touchedWorkspaces([test])[0] ?? "";
    const relative = workspace === "" ? test : test.slice(workspace.length + 1);
    byWorkspace.set(workspace, [...(byWorkspace.get(workspace) ?? []), relative]);
  }
  for (const [workspace, tests] of [...byWorkspace].sort(([a], [b]) => (a < b ? -1 : 1)))
    plan.push({
      command: "vp",
      args: ["test", "run", ...tests],
      ...(workspace === "" ? {} : { cwd: workspace }),
    });
  return plan;
};

export interface RepairRun {
  readonly command: string;
  readonly result: "passed";
}

export interface RepairFailure {
  /**
   * `environment` means the lane cannot test at all — the runner or its install is missing — and is
   * one of the walk's two legal stops. `repair` means the lane tested and the replay is not
   * healthy, which stops the walk against the rows that produced it.
   */
  readonly kind: "environment" | "repair";
  readonly command: string;
  readonly detail: string;
}

export interface RepairOutcome {
  readonly ran: ReadonlyArray<RepairRun>;
  readonly failure?: RepairFailure;
  /** The first command after which the worktree was dirty, when the caller can observe that. */
  readonly dirtiedBy?: string;
}

/** What a repair pass did, named after the command that wrote to the worktree. */
export type RepairKind = "fmt" | "typecheck" | "tests" | "additive";

export const repairKind = (command: string): RepairKind =>
  /(^|\s)additive(\s|$)/.test(command)
    ? "additive"
    : /(^|\s)fmt(\s|$)/.test(command)
      ? "fmt"
      : /(^|\s)test(\s|$)/.test(command)
        ? "tests"
        : "typecheck";

export interface RepairCommitInput {
  readonly kind: RepairKind;
  readonly tag: string;
  readonly domain: string;
  readonly command: string;
}

/**
 * A repair is the walk's own commit, never an amend of the fork commit it follows: the replayed
 * SHAs stay exactly what the rehearsal proved. `Fork-Upstreamable: no` is structural — a repair
 * exists only to keep this fork's replay green, so it is never a candidate to send anywhere — and
 * `Fork-Repair` is what the replay proofs read to keep it out of the fork series.
 */
export const repairCommitMessage = ({ kind, tag, domain, command }: RepairCommitInput): string =>
  [
    `chore(fork-sync): repair ${kind} after ${tag}`,
    "",
    `\`${command}\` rewrote the worktree while replaying onto ${tag}.`,
    "",
    `Fork-Domain: ${domain}`,
    "Fork-Tier: bugfix",
    "Fork-Upstreamable: no",
    `Fork-Repair: ${tag}`,
    "",
  ].join("\n");

/**
 * Only the runner itself failing is the environment's fault: a missing command (`127`) or a spawn
 * that never produced a status. Everything the runner did run and report is the replay's fault,
 * including a `Cannot find module` that a moved file caused.
 */
const MISSING_COMMAND_STATUS = 127;

const detailOf = (stdout: string, stderr: string): string =>
  [stderr.trim(), stdout.trim()]
    .filter((value) => value.length > 0)
    .join("\n")
    .slice(0, 4000);

export const runRepairs = (
  runner: CommandRunner,
  worktree: string,
  plan: ReadonlyArray<RepairCommand>,
  env?: NodeJS.ProcessEnv,
  /** Injected so the pass can name the command that dirtied the tree without knowing about Git. */
  isDirty?: () => boolean,
): RepairOutcome => {
  const ran: Array<RepairRun> = [];
  let dirtiedBy: string | undefined;
  for (const step of plan) {
    // The record names where a step ran, because the same suite passes from its workspace and
    // fails from the lane root, and a bare command text hides which of the two the walk did.
    const label =
      step.cwd === undefined
        ? commandText(step.command, step.args)
        : `${step.cwd}: ${commandText(step.command, step.args)}`;
    const cwd = step.cwd === undefined ? worktree : NodePath.join(worktree, step.cwd);
    let status: number;
    let detail: string;
    try {
      const result = runner.run(step.command, step.args, cwd, undefined, env);
      if (result.error !== undefined)
        return {
          ran,
          failure: { kind: "environment", command: label, detail: result.error.message },
        };
      status = result.status;
      detail = detailOf(result.stdout, result.stderr);
    } catch (error) {
      return {
        ran,
        failure: {
          kind: "environment",
          command: label,
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (status === 0) {
      ran.push({ command: label, result: "passed" });
      if (dirtiedBy === undefined && isDirty?.() === true) dirtiedBy = label;
      continue;
    }
    return {
      ran,
      ...(dirtiedBy === undefined ? {} : { dirtiedBy }),
      failure: {
        kind: status === MISSING_COMMAND_STATUS ? "environment" : "repair",
        command: label,
        detail,
      },
    };
  }
  return { ran, ...(dirtiedBy === undefined ? {} : { dirtiedBy }) };
};

/**
 * Whether a repair commit is a fix to the walk harness itself rather than to the fork's product
 * surface (RSI-Software/t3code-hyprws#690). Landed commits cannot be re-trailered, so the ledger
 * recognizes tooling repairs by what they touch — and only by what they touch. The boundary is
 * deliberately narrow and pinned by test: only paths under `scripts/` plus the fork's own
 * internals pages (`docs/internals/fork-*.md`), and only when the commit touches nothing else.
 * A repair that also touches a product path is not a tooling repair; a fork doc outside the
 * `fork-*` family is not walk tooling.
 */
export const isToolingRepair = (paths: ReadonlyArray<string>): boolean =>
  paths.length > 0 &&
  paths.every(
    (path) =>
      path === "scripts" ||
      path.startsWith("scripts/") ||
      /^docs\/internals\/fork-[^/]*\.md$/.test(path),
  );
