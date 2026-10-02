// @effect-diagnostics nodeBuiltinImport:off - The sync driver reads the workflow before any Effect runtime exists.
// Gate: sync tip — the test jobs the sync battery runs before it moves hyprws; derives them, never judges them.

// The one derivation of the hyprws CI test jobs as local `vp` commands. The
// sync driver pushes the trunk directly, so no pull request runs these jobs
// before the push; `fork:sync` runs every one of them itself, and reads them
// from the workflow so the battery never restates a job
// (RSI-Software/t3code-hyprws#1327). Anything the derivation cannot read
// exactly throws instead of being skipped, so a new step shape stops the sync
// rather than shrinking its battery.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import { FORK_CI_WORKFLOW_PATH } from "./fork-ci-flags.ts";

/** A workflow job is a test job when its id carries this prefix. */
const TEST_JOB_PREFIX = "test";

/** Runner provisioning in a test job: the sync host already carries it. */
const PROVISIONING_LINE = /^(?:sudo apt-get |git )/;

const MatrixValue = Schema.Union([Schema.String, Schema.Number]);

const WorkflowStep = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
});

const WorkflowJob = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  strategy: Schema.optionalKey(
    Schema.Struct({
      matrix: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(MatrixValue))),
    }),
  ),
  steps: Schema.Array(WorkflowStep),
});

const decodeWorkflow = Schema.decodeSync(
  fromYaml(Schema.Struct({ jobs: Schema.Record(Schema.String, WorkflowJob) })),
);

type WorkflowJob = Schema.Schema.Type<typeof WorkflowJob>;

/** One CI test job instance, a matrix cell included, as the battery runs it. */
export interface CiTestJob {
  /** The workflow job id. */
  readonly id: string;
  /** The check name CI reports, matrix values substituted. */
  readonly name: string;
  /** Every `vp` argv the job runs, in step order. */
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
}

/** Every job id the workflow declares, test or not. */
export const workflowJobIds = (source: string): ReadonlyArray<string> =>
  Object.keys(decodeWorkflow(source).jobs);

/** Split one shell command line into argv; anything beyond plain words and quotes throws. */
export const shellWords = (line: string): ReadonlyArray<string> => {
  const words: Array<string> = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (quote === '"' && /[$`\\]/.test(char))
        throw new Error(`unsupported shell syntax in: ${line}`);
      else word = (word ?? "") + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (/[|&;<>()$`\\*?[\]{}~#]/.test(char)) {
      throw new Error(`unsupported shell syntax in: ${line}`);
    } else {
      word = (word ?? "") + char;
    }
  }
  if (quote !== null) throw new Error(`unterminated quote in: ${line}`);
  if (word !== null) words.push(word);
  return words;
};

const matrixCells = (job: WorkflowJob): ReadonlyArray<Readonly<Record<string, string>>> => {
  const matrix = job.strategy?.matrix ?? {};
  return Object.entries(matrix).reduce<ReadonlyArray<Readonly<Record<string, string>>>>(
    (cells, [key, values]) =>
      cells.flatMap((cell) => values.map((value) => ({ ...cell, [key]: String(value) }))),
    [{}],
  );
};

const substitute = (text: string, cell: Readonly<Record<string, string>>, total: number): string =>
  text.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (expression, name: string) => {
    if (name === "strategy.job-total") return String(total);
    const key = name.startsWith("matrix.") ? name.slice("matrix.".length) : null;
    const value = key === null ? undefined : cell[key];
    if (value === undefined) throw new Error(`unresolvable expression ${expression} in: ${text}`);
    return value;
  });

/** A step's `vp` argv, `null` for provisioning; any other step shape throws. */
const stepCommand = (jobId: string, run: string): ReadonlyArray<string> | null => {
  const lines = run
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.every((line) => PROVISIONING_LINE.test(line))) return null;
  const words = lines.length === 1 ? shellWords(lines[0]!) : [];
  if (words[0] === "vp") return words.slice(1);
  if (words[0] === "vpr") return ["run", ...words.slice(1)];
  throw new Error(`test job ${jobId} has a step the sync battery cannot run: ${run.trim()}`);
};

/** Every test job instance in the workflow source, matrix cells expanded. */
export const deriveCiTestJobs = (source: string): ReadonlyArray<CiTestJob> => {
  const { jobs } = decodeWorkflow(source);
  return Object.entries(jobs)
    .filter(([id]) => id.startsWith(TEST_JOB_PREFIX))
    .flatMap(([id, job]) => {
      const cells = matrixCells(job);
      return cells.map((cell) => {
        const commands = job.steps.flatMap((step) => {
          if (step.run === undefined) return [];
          const command = stepCommand(id, substitute(step.run, cell, cells.length));
          return command === null ? [] : [command];
        });
        if (commands.length === 0) throw new Error(`test job ${id} runs no vp command`);
        return { id, name: substitute(job.name ?? id, cell, cells.length), commands };
      });
    });
};

/** The test jobs of the workflow checked out at `root`. */
export const ciTestJobs = (root: string): ReadonlyArray<CiTestJob> =>
  deriveCiTestJobs(NodeFS.readFileSync(NodePath.join(root, FORK_CI_WORKFLOW_PATH), "utf8"));
