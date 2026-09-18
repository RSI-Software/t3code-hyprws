#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone Git plumbing, no Effect.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  forkCommitIdentifiers,
  retireCandidateMatches,
  SystemRunner,
  type CommandRunner,
} from "./fork-sync.ts";
import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import { runCommandText } from "./lib/fork-command.ts";
import {
  FORK_RETIREMENT_LEDGER_PATH,
  normalizeSubjectKey,
  readForkRetirementLedger,
  retirementDecision,
  type RecordedRetirementDecision,
} from "./lib/fork-retirement-ledger.ts";
import { forkCommitSourceExtensions } from "./lib/fork-retire-probe.ts";

/**
 * The retire pass over the fold worklist (RSI-Software/t3code-hyprws#1098). Doctrine order is
 * retire before reshape, so before the first fold this driver walks the P0-confirmed worklist and
 * emits one candidate row per subject with its evidence sites in the target tree.
 *
 * It consumes the library predicates `fork-sync.ts` already runs on every walk — `retireCandidateMatches`
 * greps the target tree scoped by `RETIRE_PROBE_EXCLUSIONS` and admits a hit only where
 * `isRetireEvidenceSite` says the fork identifier is defined or imported in a file type
 * `forkCommitSourceExtensions` derives from the commit's own diff. Nothing here re-scores a hit.
 *
 * The output is human-adjudicated, never auto-applied. An unscoped probe once read roughly 35 of 40
 * rows as retire (RSI-Software/t3code-hyprws#688), so when the candidate share of the probed list is
 * high this driver says so out loud instead of letting the noise pass for signal. Verdicts live in
 * the fork retirement ledger (`docs/internals/fork-delta.md`), keyed by subject as human decisions;
 * this script reads them back and never writes.
 */

export interface RetireEvidenceSite {
  readonly identifier: string;
  readonly location: string;
}

export type RetirePassStatus = "retire-candidate" | "no-evidence" | "not-in-range";

export type RetirePassVerdict = RecordedRetirementDecision["decision"] | "pending";

export interface RetirePassRow {
  readonly subject: string;
  readonly status: RetirePassStatus;
  readonly commit?: string;
  readonly identifiers: ReadonlyArray<string>;
  readonly sites: ReadonlyArray<RetireEvidenceSite>;
  readonly verdict: RetirePassVerdict;
}

/** Above this share of candidate rows the pass reports itself as possibly over-broad. */
export const OVERBREADTH_FRACTION = 0.5;

const git = (root: string, args: ReadonlyArray<string>): string =>
  runCommandText("git", args, { cwd: root }).trim();

const gitRaw = (root: string, args: ReadonlyArray<string>): string =>
  runCommandText("git", args, { cwd: root });

/**
 * One worklist line is one subject. The fold queue in RSI-Software/t3code-hyprws#965 is pasted as
 * markdown checkboxes whose subjects carry ledger annotations after ` (ledger:`; both the checkbox
 * and the annotation are stripped so the stable subject key survives the paste. Blank lines and
 * `#` comments are ignored.
 */
export const parseWorklistLine = (line: string): string => {
  let text = line.trim();
  if (text.length === 0 || text.startsWith("#")) return "";
  text = text.replace(/^- \[[ xX]\]\s*/, "").replace(/^-\s*/, "");
  const annotation = / \((?:ledger:|verify |folded already\?)/.exec(text);
  if (annotation !== null) text = text.slice(0, annotation.index);
  return normalizeSubjectKey(text.trim());
};

export const parseWorklist = (contents: string): ReadonlyArray<string> =>
  contents
    .split("\n")
    .map(parseWorklistLine)
    .filter((subject) => subject.length > 0);

const commitSubjects = (
  root: string,
  base: string,
  source: string,
): ReadonlyMap<string, string> => {
  const commits = new Map<string, string>();
  for (const line of gitRaw(root, ["log", "--format=%H%x09%s", `${base}..${source}`]).split("\n")) {
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    const subject = normalizeSubjectKey(line.slice(separator + 1).trim());
    if (subject.length > 0 && !commits.has(subject)) commits.set(subject, line.slice(0, separator));
  }
  return commits;
};

const ledgerVerdicts = (
  root: string,
): ReadonlyMap<string, RecordedRetirementDecision> | undefined => {
  const path = NodePath.join(root, FORK_RETIREMENT_LEDGER_PATH);
  if (!NodeFS.existsSync(path)) return undefined;
  const ledger = readForkRetirementLedger(root);
  return new Map(
    [...ledger.retired.keys(), ...ledger.kept.keys()].map((subject) => [
      subject,
      retirementDecision(ledger, subject),
    ]),
  );
};

const verdictFor = (
  verdicts: ReadonlyMap<string, RecordedRetirementDecision> | undefined,
  subject: string,
): RetirePassVerdict => {
  const decision = verdicts?.get(subject);
  return decision === undefined ? "pending" : decision.decision;
};

export interface RetirePassOptions {
  readonly worklist: ReadonlyArray<string>;
  readonly base: string;
  readonly source: string;
  readonly target: string;
}

/**
 * Walks the worklist over the existing retire predicates. Subjects are the stable key (SHAs rot on
 * rebase), so each subject resolves to whatever commit `base..source` currently carries under it.
 */
export const retirePass = (
  runner: CommandRunner,
  root: string,
  options: RetirePassOptions,
): ReadonlyArray<RetirePassRow> => {
  const targetSha = git(root, ["rev-parse", `${options.target}^{commit}`]);
  const commits = commitSubjects(root, options.base, options.source);
  const verdicts = ledgerVerdicts(root);
  return options.worklist.map((subject) => {
    const verdict = verdictFor(verdicts, subject);
    const commit = commits.get(subject);
    if (commit === undefined) {
      return { subject, status: "not-in-range", identifiers: [], sites: [], verdict };
    }
    const diff = gitRaw(root, ["show", "--format=", "--unified=0", "--no-color", commit]);
    const identifiers = forkCommitIdentifiers(diff);
    const matches = retireCandidateMatches(
      runner,
      root,
      targetSha,
      identifiers,
      forkCommitSourceExtensions(diff),
    );
    return {
      subject,
      status: matches.length > 0 ? "retire-candidate" : "no-evidence",
      commit,
      identifiers,
      sites: matches.map(({ identifier, location }) => ({ identifier, location })),
      verdict,
    };
  });
};

export const retirePassSummary = (rows: ReadonlyArray<RetirePassRow>): string => {
  const probed = rows.filter((row) => row.status !== "not-in-range");
  const candidates = probed.filter((row) => row.status === "retire-candidate");
  const pending = rows.filter((row) => row.verdict === "pending");
  const lines = [
    `worklist: ${rows.length} subject(s), ${probed.length} probed, ${rows.length - probed.length} not in range`,
    `retire candidates: ${candidates.length} of ${probed.length} probed (${probed.length === 0 ? "0" : Math.round((candidates.length / probed.length) * 100)}%)`,
    `awaiting human verdict: ${pending.length}`,
  ];
  if (probed.length > 0 && candidates.length / probed.length >= OVERBREADTH_FRACTION) {
    lines.push(
      "",
      "WARNING: this pass reads at least half the probed worklist as retire candidates.",
      "That is the shape of the over-broad read from RSI-Software/t3code-hyprws#688, where ~35 of 40",
      "rows read retire on evidence that was noise. Adjudicate every row against its evidence sites;",
      "this driver never drops a commit and nothing here is applied without a human verdict in the",
      "retirement ledger keyed by subject.",
    );
  }
  return lines.join("\n");
};

export const renderRetirePass = (rows: ReadonlyArray<RetirePassRow>): string => {
  const lines = rows.map((row) => {
    const commit = row.commit === undefined ? "" : ` @ ${row.commit.slice(0, 10)}`;
    const sites =
      row.sites.length === 0
        ? ""
        : `\n    ${row.sites
            .map((site) => `${site.identifier} @ ${site.location}`)
            .join("\n    ")}`;
    return `- [${row.status}] ${row.subject}${commit} — verdict: ${row.verdict}${sites}`;
  });
  return [...lines, "", retirePassSummary(rows)].join("\n");
};

const usage = (): string => `fork:retire-pass — retire pass over the fold worklist

Walks a subject worklist against the existing retire predicates and emits one row
per subject with its evidence sites in the target tree. Read-only: verdicts are
human decisions recorded in the fork retirement ledger keyed by subject.

  vp run fork:retire-pass --worklist <file> --target <ref> [--base <ref>] [--source <ref>] [--json]

  --worklist <file>  one subject per line (markdown checkboxes and ledger annotations tolerated)
  --target <ref>     the upstream tree to probe for evidence sites (typically a release tag)
  --base <ref>       exclusive range base resolving subjects to commits (default: merge base of upstream/main and --source)
  --source <ref>     the fork ref carrying the worklist commits (default: HEAD)
  --json             emit the rows as JSON`;

export const run = (argv: ReadonlyArray<string>): number => {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv, {
      values: ["--worklist", "--target", "--base", "--source"],
      flags: ["--json", "--help"],
    });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
    return 2;
  }
  if (args.flags.has("--help")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const worklistPath = args.values.get("--worklist");
  const target = args.values.get("--target");
  if (worklistPath === undefined || target === undefined) {
    process.stderr.write("usage: --worklist and --target are required\nTry --help.\n");
    return 2;
  }
  const root = process.cwd();
  const source = args.values.get("--source") ?? "HEAD";
  const base = args.values.get("--base") ?? git(root, ["merge-base", "upstream/main", source]);
  const worklist = parseWorklist(NodeFS.readFileSync(worklistPath, "utf8"));
  if (worklist.length === 0) {
    process.stderr.write(`no subjects parsed from ${worklistPath}\n`);
    return 2;
  }
  const rows = retirePass(new SystemRunner(), root, { worklist, base, source, target });
  if (args.flags.has("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${renderRetirePass(rows)}\n`);
  return 0;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
