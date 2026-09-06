import { git, REPOSITORY, requireSuccess } from "./fork-sync-state.ts";
import { type CwdCommandRunner as CommandRunner } from "./lib/fork-command.ts";

/**
 * `hyprws CI` is the fork's only full-suite authority. The series rewrite lane and the stable cut's
 * prepare take their `check`, `typecheck`, and `test` verdict from a run on the exact pushed head,
 * because running that battery on the operator machine has killed panes under memory pressure.
 *
 * The unattended unblock walk does not come here. It verifies in the lane it just built, with a
 * repair pass scoped to what the replay touched, so it never has to push a lane and wait on a
 * verdict it could not act on. Trunk CI is what checks the walk's apply, after the fact.
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

/**
 * A completed red run is a failed gate, so its diagnostic has to terminate on every input. A run
 * log is arbitrary job output: tens of megabytes, ANSI-bearing, single lines of unbounded length,
 * and sometimes unreadable because the archive is not published yet. None of that may turn a red
 * gate into a hang or a message no operator can read, so the evidence is capped on every axis and
 * every retrieval failure degrades to what the run itself already told us.
 */
const EVIDENCE_JOB_LINES = 40;
const EVIDENCE_LINE_CHARS = 400;
const EVIDENCE_CHARS = 20_000;

// CSI and OSC colouring plus stray control bytes. Tab survives: it delimits the job/step columns.
const CONTROL_SEQUENCES = new RegExp(
  [
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
    "\\u001B\\[[0-9;?]*[ -/]*[@-~]",
    "\\u001B[@-Z\\\\-_]",
    "[\\u0000-\\u0008\\u000B-\\u001F\\u007F]",
  ].join("|"),
  "g",
);

const readableLine = (line: string): string => {
  const stripped = line.replace(CONTROL_SEQUENCES, "");
  return stripped.length > EVIDENCE_LINE_CHARS
    ? `${stripped.slice(0, EVIDENCE_LINE_CHARS)}… [line truncated]`
    : stripped;
};

const boundedEvidence = (lines: ReadonlyArray<string>): string => {
  const text = lines.join("\n");
  return text.length > EVIDENCE_CHARS
    ? `${text.slice(0, EVIDENCE_CHARS)}\n… [evidence truncated at ${EVIDENCE_CHARS} characters]`
    : text;
};

/**
 * One pass over the log that retains only each named job's last `EVIDENCE_JOB_LINES` lines, so the
 * excerpt costs the same on a 40 KB log and a 40 MB one.
 */
const jobLogTails = (
  log: string,
  names: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const tails = new Map<string, Array<string>>(names.map((name) => [name, []]));
  for (let start = 0; start <= log.length;) {
    const linebreak = log.indexOf("\n", start);
    const end = linebreak < 0 ? log.length : linebreak;
    const column = log.indexOf("\t", start);
    if (column >= 0 && column < end) {
      const tail = tails.get(log.slice(start, column));
      if (tail !== undefined) {
        tail.push(readableLine(log.slice(start, end)));
        if (tail.length > EVIDENCE_JOB_LINES) tail.shift();
      }
    }
    if (linebreak < 0) break;
    start = linebreak + 1;
  }
  return tails;
};

const attempt = <T>(read: () => T): { readonly value: T } | { readonly failure: string } => {
  try {
    return { value: read() };
  } catch (error) {
    return { failure: readableLine(error instanceof Error ? error.message : String(error)) };
  }
};

const failedJobsOf = (runner: CommandRunner, worktree: string, run: CiRun): ReadonlyArray<CiJob> =>
  (
    JSON.parse(
      requireSuccess(
        runner,
        "gh",
        ["run", "view", String(run.databaseId), "--json", "jobs", "-R", REPOSITORY],
        worktree,
      ),
    ) as { readonly jobs: ReadonlyArray<CiJob> }
  ).jobs.filter(
    ({ conclusion }) =>
      conclusion !== null && !["success", "skipped", "neutral"].includes(conclusion),
  );

const failedCiEvidence = (runner: CommandRunner, worktree: string, run: CiRun): string => {
  const known = [
    `hyprws CI failed: ${run.url}`,
    `run ${run.databaseId} concluded ${run.conclusion ?? "unknown"} on the pushed head`,
  ];
  const jobs = attempt(() => failedJobsOf(runner, worktree, run));
  if ("failure" in jobs)
    return boundedEvidence([...known, `failed job list unavailable: ${jobs.failure}`]);
  known.push(
    jobs.value.length === 0
      ? "failed jobs: none reported; treat the run conclusion as the verdict"
      : `failed jobs: ${jobs.value.map(({ name }) => name).join(", ")}`,
  );
  const log = attempt(() =>
    requireSuccess(
      runner,
      "gh",
      ["run", "view", String(run.databaseId), "--log-failed", "-R", REPOSITORY],
      worktree,
    ),
  );
  if ("failure" in log)
    return boundedEvidence([...known, `failed job log unavailable: ${log.failure}`]);
  const tails = jobLogTails(
    log.value,
    jobs.value.map(({ name }) => name),
  );
  return boundedEvidence([
    ...known,
    ...jobs.value.flatMap(({ name, conclusion }) => {
      const tail = tails.get(name) ?? [];
      return [
        `Failing job: ${name} (${conclusion ?? "unknown"})`,
        ...(tail.length === 0 ? ["no log lines carried this job name"] : tail),
      ];
    }),
  ]);
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
