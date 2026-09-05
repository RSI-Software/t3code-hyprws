// @effect-diagnostics nodeBuiltinImport:off - Standalone fork receipt collection, before an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { AutoRebasePlan } from "./fork-auto-rebase-plan.ts";
import type { AutoRebaseOptions, AutoRebaseResult } from "./fork-auto-rebase.ts";
import type { SyncReport } from "./fork-sync-state.ts";
import { readReport } from "./fork-sync-state.ts";
import { runCommandText, runCommand } from "./lib/fork-command.ts";
import { CHURN_REF, pushBotRefWithLease, resolveBotRef } from "./lib/fork-bot-refs.ts";
import { readChurnState, writeChurnState } from "./fork-churn-ledger.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";
import { UsageError } from "./lib/fork-cli.ts";
import {
  requireOutcomeReceipts,
  summarizeOutcomes,
  outcomeStreak,
  type OutcomeAttempt,
  type OutcomeReceipt,
  type OutcomeStageReceipt,
  type OutcomeStatus,
} from "./lib/fork-sync-outcomes.ts";

const runUrl = () =>
  process.env.GITHUB_RUN_ID
    ? `https://github.com/${FORK_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "local operator receipt";
const attemptId = () =>
  process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT ?? "1"}/${process.env.GITHUB_JOB ?? "local"}`
    : `local/${NodeCrypto.randomUUID()}`;
const trigger = (): OutcomeAttempt["trigger"] => {
  const event = process.env.GITHUB_EVENT_NAME;
  return event === "workflow_dispatch"
    ? "manual"
    : event === "schedule" || event === "push"
      ? event
      : "unknown";
};
export const declareOutcomeAttempt = (
  target: { readonly sha: string; readonly tag: string },
  sourceSha: string,
  mode: OutcomeAttempt["mode"],
  executor: OutcomeAttempt["executor"],
  id = attemptId(),
): ReadonlyArray<OutcomeReceipt> => [
  {
    kind: "target",
    target,
    eligible: true,
    reason: "selected tagged target under the fork tag policy",
  },
  {
    kind: "attempt",
    targetSha: target.sha,
    attemptId: id,
    sourceSha,
    trigger: trigger(),
    executor,
    mode,
    runUrl: runUrl(),
  },
];
const saveBundle = (path: string, receipts: ReadonlyArray<OutcomeReceipt>): void => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(
    path,
    `${JSON.stringify({ version: 1, receipts: requireOutcomeReceipts(receipts) }, null, 2)}\n`,
  );
};
const readBundle = (path: string): ReadonlyArray<OutcomeReceipt> => {
  const value = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
    version?: unknown;
    receipts?: unknown;
  };
  if (
    value.version !== 1 ||
    Object.keys(value).some((key) => key !== "version" && key !== "receipts")
  )
    throw new Error("expected outcome bundle {version:1, receipts:[...]}");
  return requireOutcomeReceipts(value.receipts);
};
const stage = (
  attempt: OutcomeAttempt,
  name: OutcomeStageReceipt["stage"],
  status: OutcomeStatus,
  detail: string,
  sha?: string,
): OutcomeStageReceipt => ({
  kind: "stage",
  targetSha: attempt.targetSha,
  attemptId: attempt.attemptId,
  stage: name,
  status,
  detail,
  evidenceUrl: attempt.runUrl,
  ...(sha === undefined ? {} : { sha }),
});

/** Write selection declarations before executing the rebase, so thrown failures retain identity. */
export const prepareAutoOutcome = (
  path: string,
  plan: AutoRebasePlan,
  options: AutoRebaseOptions,
): void => {
  const targets = new Map(
    [plan.target, plan.censusTarget, plan.newestTagBeyondWindow]
      .filter((target) => target !== null)
      .map((target) => [target.sha, { sha: target.sha, tag: target.tag }]),
  );
  saveBundle(
    path,
    [...targets.values()].flatMap((target) =>
      declareOutcomeAttempt(target, plan.oldSha, options.mode, "bot"),
    ),
  );
};

export const autoOutcomeReceipts = (
  declarations: ReadonlyArray<OutcomeReceipt>,
  result: AutoRebaseResult | null,
  reporting?: {
    readonly publication: OutcomeStatus;
    readonly policy: OutcomeStatus;
    readonly url?: string;
  },
): ReadonlyArray<OutcomeReceipt> => {
  const receipts = [...declarations];
  const targets = declarations.filter((row) => row.kind === "target");
  for (const attempt of declarations.filter(
    (row): row is OutcomeAttempt => row.kind === "attempt",
  )) {
    const selected = result?.target?.sha === attempt.targetSha;
    const blocked =
      result?.blocked !== null &&
      result?.blocked !== undefined &&
      result.blocked.newestUpstreamTagBeyondWindow ===
        targets.find((row) => row.target.sha === attempt.targetSha)?.target.tag;
    receipts.push(
      stage(
        attempt,
        "selection",
        result === null
          ? "unknown"
          : blocked
            ? "blocked"
            : selected
              ? "succeeded"
              : "not-attempted",
        result === null
          ? "planner retained identity; execution did not produce a terminal report"
          : blocked
            ? "target blocked by retained census"
            : selected
              ? "selected clean target"
              : "candidate was not selected for apply",
      ),
    );
    receipts.push(
      stage(
        attempt,
        "verification",
        selected && result?.newSha ? "succeeded" : result === null ? "unknown" : "not-attempted",
        selected && result?.newSha
          ? "replay verifier completed before publication"
          : "no passing replay verification receipt",
        selected && result?.newSha ? result.newSha : undefined,
      ),
    );
    receipts.push(
      stage(
        attempt,
        "apply",
        selected &&
          result?.status === "advanced" &&
          result.mode === "on" &&
          !result.dryRun &&
          result.newSha
          ? "succeeded"
          : result === null
            ? "unknown"
            : "not-attempted",
        selected && result?.status === "advanced" && result.mode === "on" && !result.dryRun
          ? "leased trunk publication completed"
          : "no successful trunk apply receipt",
        selected &&
          result?.status === "advanced" &&
          result.mode === "on" &&
          !result.dryRun &&
          result.newSha
          ? result.newSha
          : undefined,
      ),
    );
    if (reporting && blocked) {
      receipts.push({
        ...stage(
          attempt,
          "report-publication",
          reporting.publication,
          "churn comment publication result",
        ),
        ...(reporting.url ? { evidenceUrl: reporting.url } : {}),
      });
      receipts.push(
        stage(
          attempt,
          "report-policy",
          reporting.policy,
          "churn policy verdict is independent of publication",
        ),
      );
    }
  }
  return requireOutcomeReceipts(receipts);
};

export const syncOutcomeReceipts = (
  report: SyncReport,
  id = attemptId(),
): ReadonlyArray<OutcomeReceipt> => {
  if (!report.target || !report.source) return [];
  const executor = report.botCarried
    ? "bot"
    : process.env.FORK_OUTCOME_EXECUTOR === "agent"
      ? "agent"
      : process.env.FORK_OUTCOME_EXECUTOR === "human"
        ? "human"
        : "unknown";
  const receipts = [
    ...declareOutcomeAttempt(
      report.target,
      report.source.expectedOld,
      report.botCarried ? "on" : "unknown",
      executor,
      id,
    ),
  ];
  const attempt = receipts[1] as OutcomeAttempt;
  receipts.push(
    stage(attempt, "selection", "succeeded", "target bound by the retained sync report"),
  );
  const verified = report.ciHead !== undefined && report.ciHead === report.installedHead;
  receipts.push(
    stage(
      attempt,
      "verification",
      verified ? "succeeded" : report.stage === "conflicts" ? "blocked" : "unknown",
      verified
        ? "retained checked CI head"
        : `walk stopped at ${report.stage}; no matching CI-head receipt`,
      verified ? report.ciHead : undefined,
    ),
  );
  receipts.push(
    stage(
      attempt,
      "apply",
      report.stage === "applied" ? "succeeded" : "not-attempted",
      report.stage === "applied"
        ? "durable trunk apply in retained report"
        : "checked/installed lane head is not trunk apply",
      report.stage === "applied" ? report.installedHead : undefined,
    ),
  );
  if (report.rererePublication)
    receipts.push(
      stage(
        attempt,
        "rerere",
        report.rererePublication.state === "published" ? "succeeded" : "pending",
        report.rererePublication.error ?? `rerere publication ${report.rererePublication.state}`,
      ),
    );
  return requireOutcomeReceipts(receipts);
};

/** Sidecar is local evidence only. Publishing the bot ledger stays an explicit outcome command. */
export const captureSyncOutcome = (report: SyncReport): void => {
  const receipts = syncOutcomeReceipts(report);
  if (receipts.length === 0) return;
  const path = `${report.reportPath}.outcome.json`;
  const previous = NodeFS.existsSync(path) ? readBundle(path) : [];
  saveBundle(path, [...previous, ...receipts]);
};

export const recordOutcomes = (
  root: string,
  incoming: ReadonlyArray<OutcomeReceipt>,
  push: boolean,
): number => {
  const expectedOld = resolveBotRef(root, CHURN_REF);
  if (expectedOld === null) throw new Error("seed the churn ledger before recording outcomes");
  const state = readChurnState(root);
  const outcomes = requireOutcomeReceipts([...state.outcomes, ...incoming]);
  const added = outcomes.length - state.outcomes.length;
  const commit =
    added === 0
      ? expectedOld
      : writeChurnState(root, { ...state, outcomes }, "churn: record target outcomes");
  if (push) {
    try {
      pushBotRefWithLease(root, CHURN_REF, expectedOld);
    } catch (error) {
      if (commit !== expectedOld)
        runCommandText("git", ["update-ref", CHURN_REF, expectedOld, commit], { cwd: root });
      throw error;
    }
  }
  process.stdout.write(
    `${JSON.stringify({ added, commit, ...outcomeStreak(outcomes) }, null, 2)}\n`,
  );
  return 0;
};

export interface ReleaseOutcomeInput {
  readonly target: { readonly tag: string; readonly sha: string };
  readonly attemptId: string;
  readonly releasedSha: string;
  readonly appliedSha: string | null;
  readonly version: string;
  readonly tag: string;
  readonly verification: OutcomeStatus;
  readonly build: OutcomeStatus;
  readonly publication: OutcomeStatus;
  readonly expectedAssets: ReadonlyArray<string>;
  readonly publishedAssets: ReadonlyArray<{
    readonly name: string;
    readonly size: number;
    readonly digest: string;
  }>;
  readonly interveningCommits: ReadonlyArray<string>;
  readonly tagSha: string | null;
}

export const releaseOutcomeReceipts = (
  input: ReleaseOutcomeInput,
): ReadonlyArray<OutcomeReceipt> => {
  const receipts = [
    ...declareOutcomeAttempt(input.target, input.releasedSha, "unknown", "bot", input.attemptId),
  ];
  const attempt = receipts[1] as OutcomeAttempt;
  receipts.push(
    stage(
      attempt,
      "release-verification",
      input.verification,
      "release preflight result for the exact checkout",
      input.releasedSha,
    ),
  );
  receipts.push(
    stage(
      attempt,
      "release-build",
      input.build,
      "release build result for the exact preflight checkout",
      input.releasedSha,
    ),
  );
  const verified = input.verification === "succeeded" && input.build === "succeeded";
  const completeAssets =
    input.expectedAssets.length > 0 &&
    input.expectedAssets.every((name) =>
      input.publishedAssets.some(
        (asset) =>
          asset.name === name && asset.size > 0 && /^sha256:[a-f0-9]{64}$/.test(asset.digest),
      ),
    );
  const complete =
    verified &&
    input.publication === "succeeded" &&
    input.tagSha === input.releasedSha &&
    input.appliedSha !== null &&
    completeAssets;
  const failed = [input.verification, input.build, input.publication].includes("failed");
  const evidence =
    input.appliedSha && input.verification === "succeeded"
      ? {
          appliedSha: input.appliedSha,
          releasedSha: input.releasedSha,
          version: input.version,
          tag: input.tag,
          tagSha: input.tagSha,
          expectedAssets: input.expectedAssets,
          publishedAssets: input.publishedAssets,
          interveningCommits: input.interveningCommits,
          verifiedSha: input.releasedSha,
          verificationUrl: attempt.runUrl,
        }
      : undefined;
  receipts.push({
    ...stage(
      attempt,
      "distribution",
      complete
        ? "succeeded"
        : failed
          ? "failed"
          : input.publication === "not-attempted"
            ? "not-attempted"
            : input.appliedSha === null
              ? "unknown"
              : "failed",
      complete
        ? "tag commit and every expected asset verified against GitHub publication"
        : `release incomplete: preflight=${input.verification}, build=${input.build}, publication=${input.publication}, assets=${completeAssets}, tagMatches=${input.tagSha === input.releasedSha}, retainedApply=${input.appliedSha !== null}`,
      input.releasedSha,
    ),
    ...(evidence === undefined ? {} : { distribution: evidence }),
  });
  // The successful distribution's retained apply is validated when merged into the ledger.
  return receipts;
};

const jobStatus = (value: unknown): OutcomeStatus =>
  value === "success"
    ? "succeeded"
    : value === "failure" || value === "cancelled"
      ? "failed"
      : value === "skipped"
        ? "not-attempted"
        : "unknown";
const collectRelease = (root: string): ReadonlyArray<OutcomeReceipt> => {
  const needs = JSON.parse(process.env.FORK_RELEASE_NEEDS ?? "{}") as Record<
    string,
    { result?: string; outputs?: Record<string, string> }
  >;
  const outputs = needs.preflight?.outputs ?? {};
  const releasedSha = outputs.ref;
  if (!releasedSha)
    throw new Error(
      "release preflight did not identify its checkout; retain the workflow artifact as unknown evidence",
    );
  const git = (args: ReadonlyArray<string>) => runCommandText("git", args, { cwd: root }).trim();
  const candidates = summarizeOutcomes(readChurnState(root).outcomes)
    .filter(
      (row) =>
        row.appliedSha !== null &&
        runCommand("git", ["merge-base", "--is-ancestor", row.appliedSha, releasedSha], {
          cwd: root,
        }).status === 0,
    )
    .map((row) => ({
      row,
      distance: Number(git(["rev-list", "--count", `${row.appliedSha}..${releasedSha}`])),
    }))
    .toSorted((left, right) => left.distance - right.distance);
  const selected = candidates[0]?.row;
  const baseSha = selected?.target.sha ?? git(["merge-base", releasedSha, "upstream/main"]);
  const target = selected?.target ?? {
    sha: baseSha,
    tag: git(["describe", "--tags", "--exact-match", baseSha]),
  };
  const published = outputs.tag
    ? runCommand("gh", ["api", `repos/${FORK_REPOSITORY}/releases/tags/${outputs.tag}`], {
        cwd: root,
      })
    : { status: 1, stdout: "" };
  let assets: Array<{ name: string; size: number; digest: string }> = [];
  if (published.status === 0) {
    const release = JSON.parse(published.stdout) as {
      assets?: Array<{ name: string; size: number; digest?: string | null }>;
    };
    assets = (release.assets ?? []).map((asset) => ({
      name: asset.name,
      size: asset.size,
      digest: asset.digest ?? "unknown",
    }));
  }
  const tag = runCommand("git", ["rev-parse", `refs/tags/${outputs.tag}^{commit}`], { cwd: root });
  return releaseOutcomeReceipts({
    target,
    attemptId: attemptId(),
    releasedSha,
    appliedSha: selected?.appliedSha ?? null,
    version: outputs.version ?? "unknown: preflight stopped before version resolution",
    tag: outputs.tag ?? "unknown: preflight stopped before tag resolution",
    verification: jobStatus(needs.preflight?.result),
    build: jobStatus(needs.build?.result),
    publication:
      published.status === 0
        ? jobStatus(needs.release?.result)
        : needs.release?.result === "skipped"
          ? "not-attempted"
          : "failed",
    expectedAssets: JSON.parse(needs.build?.outputs?.expected_assets ?? "[]"),
    publishedAssets: assets,
    interveningCommits:
      selected?.appliedSha === undefined || selected.appliedSha === null
        ? []
        : git(["rev-list", "--reverse", `${selected.appliedSha}..${releasedSha}`])
            .split("\n")
            .filter(Boolean),
    tagSha: tag.status === 0 ? tag.stdout.trim() : null,
  });
};

export const runOutcome = (argv: ReadonlyArray<string>, root: string): number => {
  const options = new Map<string, string>();
  let push = false;
  let release = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (name === "--push" && !push) {
      push = true;
      continue;
    }
    if (name === "--release" && !release) {
      release = true;
      continue;
    }
    if (
      !["--input", "--auto-report", "--sync-report", "--report-receipt"].includes(name) ||
      options.has(name) ||
      !argv[index + 1] ||
      argv[index + 1]!.startsWith("--")
    )
      throw new UsageError(`invalid outcome option: ${name}`);
    options.set(name, NodePath.resolve(root, argv[++index]!));
  }
  if (
    ["--input", "--auto-report", "--sync-report"].filter((name) => options.has(name)).length +
      Number(release) !==
    1
  )
    throw new UsageError(
      "outcome requires exactly one of --input, --auto-report, --sync-report, --release",
    );
  if (options.has("--report-receipt") && !options.has("--auto-report"))
    throw new UsageError("--report-receipt requires --auto-report");
  let receipts: ReadonlyArray<OutcomeReceipt>;
  if (release) receipts = collectRelease(root);
  else if (options.has("--input")) receipts = readBundle(options.get("--input")!);
  else if (options.has("--sync-report")) {
    const path = options.get("--sync-report")!;
    if (!NodeFS.existsSync(path)) {
      const tag = process.env.FORK_OUTCOME_TARGET;
      if (!tag) throw new Error("missing sync report and explicit target identity");
      const git = (args: ReadonlyArray<string>) =>
        runCommandText("git", args, { cwd: root }).trim();
      const declarations = declareOutcomeAttempt(
        { tag, sha: git(["rev-parse", `${tag}^{commit}`]) },
        git(["rev-parse", "HEAD"]),
        "on",
        "bot",
      );
      const attempt = declarations[1] as OutcomeAttempt;
      receipts = [
        ...declarations,
        stage(attempt, "selection", "unknown", "carry failed before retaining a sync report"),
        stage(attempt, "apply", "unknown", "no report proves whether trunk apply was attempted"),
      ];
    } else {
      if (!NodeFS.existsSync(`${path}.outcome.json`)) captureSyncOutcome(readReport(path));
      receipts = readBundle(`${path}.outcome.json`);
    }
    if (process.env.FORK_OUTCOME_CACHE_EXPORT) {
      const attempts = receipts.filter((row): row is OutcomeAttempt => row.kind === "attempt");
      const attempt = attempts.at(-1);
      if (attempt)
        receipts = [
          ...receipts,
          stage(
            attempt,
            "cache-export",
            jobStatus(process.env.FORK_OUTCOME_CACHE_EXPORT),
            "workflow rerere cache export result; independent of durable trunk apply",
          ),
        ];
    }
  } else {
    const path = options.get("--auto-report")!;
    const result = NodeFS.existsSync(path)
      ? (JSON.parse(NodeFS.readFileSync(path, "utf8")) as AutoRebaseResult)
      : null;
    const reportingPath = options.get("--report-receipt");
    const reporting =
      reportingPath && NodeFS.existsSync(reportingPath)
        ? JSON.parse(NodeFS.readFileSync(reportingPath, "utf8"))
        : undefined;
    receipts = autoOutcomeReceipts(readBundle(`${path}.outcome.json`), result, reporting);
  }
  if (process.env.FORK_OUTCOME_EXPORT)
    saveBundle(process.env.FORK_OUTCOME_EXPORT, [...readChurnState(root).outcomes, ...receipts]);
  return recordOutcomes(root, receipts, push);
};
