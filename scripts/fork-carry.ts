#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - Workflow glue for the carried unblock walk.

// The glue the auto-rebase workflow needs around `unblock-auto --bot-carried`
// (RSI-Software/t3code-hyprws#444). Every verb is one step of that job: carry the
// shared rerere cache, record the walk's churn row, or hand a stop back to the
// notification issue. Nothing here decides anything; the walk already did.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  restoreRerereCache,
  RERERE_REF,
  publishRerereSnapshot,
  saveRerereCache,
} from "./lib/fork-bot-refs.ts";
import { runCommandText } from "./lib/fork-command.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";
import { run as runChurn } from "./fork-churn.ts";
import type { SyncReport } from "./fork-sync-state.ts";

const USAGE =
  "usage: fork-carry rerere-restore | rerere-save [--push] | churn-row --report <json> | stop-surface --report <json> --log <file>";

const optionValue = (argv: ReadonlyArray<string>, flag: string): string => {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} is required`);
  return value;
};

const readSyncReport = (path: string): SyncReport =>
  JSON.parse(NodeFS.readFileSync(path, "utf8")) as SyncReport;

const rerereRestore = (root: string): number => {
  const restored = restoreRerereCache(root);
  process.stdout.write(
    restored ? `restored ${RERERE_REF}\n` : `${RERERE_REF} has no cache yet; starting empty\n`,
  );
  return 0;
};

const rerereSave = (argv: ReadonlyArray<string>, root: string): number => {
  const commit = saveRerereCache(root, `rerere: ${process.env.GITHUB_RUN_ID ?? "local"}`);
  if (commit === null) {
    process.stdout.write("rerere cache is empty; nothing to store\n");
    return 0;
  }
  const published = argv.includes("--push") ? publishRerereSnapshot(root, commit) : commit;
  process.stdout.write(
    `${RERERE_REF} at ${published}${argv.includes("--push") ? " (pushed)" : ""}\n`,
  );
  return 0;
};

/** The walk applied, so its row joins the ledger on the bot-owned ref. */
const churnRow = (argv: ReadonlyArray<string>, root: string): number => {
  const report = readSyncReport(optionValue(argv, "--report"));
  if (report.stage !== "applied") throw new Error(`carried walk is ${report.stage}, not applied`);
  const tag = report.target?.tag;
  const before = report.source?.expectedOld;
  const after = report.installedHead;
  if (tag === undefined || before === undefined || after === undefined)
    throw new Error("applied report is missing its tag, lease, or installed head");
  return runChurn(
    [
      "append",
      "--record",
      report.recordPath,
      "--issue",
      String(report.issue.number),
      "--tag",
      tag,
      "--before",
      before,
      "--after",
      after,
      "--push",
    ],
    root,
  );
};

const STOP_HEADING = "## Carried walk stopped";

/**
 * The stop surface verbatim, so the agent that picks the walk up reads exactly what
 * the walk refused on. The runner's report is gone by then, so the resume line the
 * walk printed is replaced by the local restart.
 */
export const renderStopComment = (log: string, tag: string): string =>
  [
    STOP_HEADING,
    "",
    `The auto-rebase bot carried an unblock walk onto \`${tag}\` and stopped. Its report and`,
    "rehearsal lane were on the runner and are gone; restart the walk locally:",
    "",
    "```",
    `node scripts/fork-sync.ts unblock-auto --target ${tag}`,
    "```",
    "",
    "Stop surface from the carried walk:",
    "",
    "```",
    log
      .split("\n")
      .filter((line) => !line.startsWith("resume: node scripts/fork-sync.ts"))
      .join("\n")
      .trimEnd(),
    "```",
  ].join("\n");

const stopSurface = (argv: ReadonlyArray<string>, root: string): number => {
  const report = readSyncReport(optionValue(argv, "--report"));
  const log = NodeFS.readFileSync(optionValue(argv, "--log"), "utf8");
  const body = renderStopComment(log, report.target?.tag ?? "the blocking tag");
  const bodyPath = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(process.env.RUNNER_TEMP ?? "/tmp", "fork-carry-")),
    "stop.md",
  );
  NodeFS.writeFileSync(bodyPath, body);
  const url = runCommandText(
    "gh",
    [
      "issue",
      "comment",
      String(report.issue.number),
      "--repo",
      FORK_REPOSITORY,
      "--body-file",
      bodyPath,
    ],
    { cwd: root },
  ).trim();
  process.stdout.write(`stop surface on #${report.issue.number}: ${url}\n`);
  return 0;
};

export const run = (argv: ReadonlyArray<string>, root = process.cwd()): number => {
  try {
    const [verb, ...args] = argv;
    if (verb === "rerere-restore") return rerereRestore(root);
    if (verb === "rerere-save") return rerereSave(args, root);
    if (verb === "churn-row") return churnRow(args, root);
    if (verb === "stop-surface") return stopSurface(args, root);
    throw new Error(USAGE);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
