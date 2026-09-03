import { git, REPOSITORY, requireSuccess } from "./fork-sync-state.ts";
import { type CwdCommandRunner as CommandRunner } from "./lib/fork-command.ts";

/**
 * `hyprws CI` is the fork's only full-suite authority. Both the unblock lane's gate 3 and the
 * stable cut's prepare take their `check`, `typecheck`, and `test` verdict from a run on the exact
 * pushed head, because running that battery on the operator machine has killed panes under memory
 * pressure.
 */
export interface CiRun {
  readonly databaseId: number;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
}

interface CiJob {
  readonly name: string;
  readonly conclusion: string | null;
}

const CI_POLL_SECONDS = 30;
const CI_POLL_LIMIT = 91;

export const remoteLaneHead = (
  runner: CommandRunner,
  worktree: string,
  branch: string,
  rehearsal = false,
): string =>
  git(
    runner,
    worktree,
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    rehearsal,
  ).split(/\s+/, 1)[0] ?? "";

const failedCiEvidence = (runner: CommandRunner, worktree: string, run: CiRun): string => {
  const jobs = JSON.parse(
    requireSuccess(
      runner,
      "gh",
      ["run", "view", String(run.databaseId), "--json", "jobs", "-R", REPOSITORY],
      worktree,
    ),
  ) as { readonly jobs: ReadonlyArray<CiJob> };
  const failedJobs = jobs.jobs.filter(
    ({ conclusion }) =>
      conclusion !== null && !["success", "skipped", "neutral"].includes(conclusion),
  );
  const log = requireSuccess(
    runner,
    "gh",
    ["run", "view", String(run.databaseId), "--log-failed", "-R", REPOSITORY],
    worktree,
  );
  return [
    `hyprws CI failed: ${run.url}`,
    ...failedJobs.map(({ name }) => {
      const jobLog = log.split("\n").filter((line) => line.startsWith(`${name}\t`));
      return [`Failing job: ${name}`, ...jobLog.slice(-40)].join("\n");
    }),
  ].join("\n");
};

export const waitForCiVerdict = (
  runner: CommandRunner,
  worktree: string,
  branch: string,
  head: string,
): CiRun => {
  let printedUrl = false;
  for (let poll = 0; poll < CI_POLL_LIMIT; poll += 1) {
    const runs = JSON.parse(
      requireSuccess(
        runner,
        "gh",
        [
          "run",
          "list",
          "--workflow",
          "hyprws-ci.yml",
          "--branch",
          branch,
          "--json",
          "databaseId,headSha,status,conclusion,url",
          "-R",
          REPOSITORY,
        ],
        worktree,
      ),
    ) as ReadonlyArray<CiRun>;
    const run = runs.find(({ headSha }) => headSha === head);
    if (run !== undefined) {
      if (!printedUrl) {
        process.stdout.write(`${run.url}\n`);
        printedUrl = true;
      }
      if (run.status === "completed") {
        if (run.conclusion !== "success") throw new Error(failedCiEvidence(runner, worktree, run));
        return run;
      }
    }
    if (poll + 1 < CI_POLL_LIMIT)
      requireSuccess(runner, "sleep", [String(CI_POLL_SECONDS)], worktree);
  }
  throw new Error(`hyprws CI timed out after 45 minutes waiting for ${head} on ${branch}`);
};
