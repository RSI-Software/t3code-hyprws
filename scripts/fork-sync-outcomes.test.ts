// @effect-diagnostics nodeBuiltinImport:off - the reapply fixture stages a real conflicted git index.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  canonicalizeOutcomeReceipts,
  requireOutcomeReceipts,
  outcomeStreak,
  summarizeOutcomes,
  type OutcomeAttempt,
  type OutcomeReceipt,
  type OutcomeStageReceipt,
} from "./lib/fork-sync-outcomes.ts";
import {
  autoOutcomeReceipts,
  releaseOutcomeReceipts,
  syncOutcomeReceipts,
} from "./fork-churn-outcomes.ts";
import { parseChurnState } from "./fork-churn-ledger.ts";
import type { AutoRebaseResult } from "./fork-auto-rebase.ts";
import { SystemCommandRunner, type CommandResult, type CommandRunner } from "./lib/fork-command.ts";
import { executeConflictOutcome, isUnresolved } from "./lib/fork-conflict-outcomes.ts";
import type { SyncReport } from "./fork-sync-state.ts";

const A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40),
  D = "d".repeat(40);
const target = {
  kind: "target",
  target: { tag: "v1-nightly.1", sha: A },
  eligible: true,
  reason: "selected tagged target under the fork tag policy",
} as const;
const attempt = (id = "sync/1", overrides: Partial<OutcomeAttempt> = {}): OutcomeAttempt => ({
  kind: "attempt",
  targetSha: A,
  attemptId: id,
  sourceSha: B,
  trigger: "schedule",
  executor: "bot",
  mode: "on",
  runUrl: "https://example.test/run/1",
  ...overrides,
});
const stage = (
  name: OutcomeStageReceipt["stage"],
  status: OutcomeStageReceipt["status"],
  overrides: Partial<OutcomeStageReceipt> = {},
): OutcomeStageReceipt => ({
  kind: "stage",
  targetSha: A,
  attemptId: "sync/1",
  stage: name,
  status,
  detail: "fixture evidence",
  ...overrides,
});
const clean: ReadonlyArray<OutcomeReceipt> = [
  target,
  attempt(),
  stage("selection", "succeeded"),
  stage("verification", "succeeded", { sha: C }),
  stage("apply", "succeeded", { sha: C }),
  stage("rerere", "not-attempted", { notApplicableReason: "direct-clean-rebase" }),
  stage("cache-export", "not-attempted", { notApplicableReason: "direct-clean-rebase" }),
];
const release = (overrides: Partial<Parameters<typeof releaseOutcomeReceipts>[0]> = {}) =>
  releaseOutcomeReceipts({
    target: target.target,
    attemptId: "release/1",
    releasedSha: C,
    appliedSha: C,
    version: "1-hyprws-nightly.1",
    tag: "v1-hyprws-nightly.1",
    verification: "succeeded",
    build: "succeeded",
    publication: "succeeded",
    expectedAssets: ["app.AppImage", "latest-linux.yml"],
    publishedAssets: [
      { name: "app.AppImage", size: 10, digest: `sha256:${"a".repeat(64)}` },
      { name: "latest-linux.yml", size: 2, digest: `sha256:${"b".repeat(64)}` },
    ],
    interveningCommits: [],
    tagSha: C,
    ...overrides,
  });

it("counts a verified automatic carry independently of its later distribution", () => {
  assert.strictEqual(outcomeStreak(clean).noAgentCarry, 1);
  assert.strictEqual(outcomeStreak(clean).distributed, 0);
  const distributed = requireOutcomeReceipts([...clean, ...release()]);
  assert.strictEqual(outcomeStreak(distributed).noAgentCarry, 1);
  assert.strictEqual(outcomeStreak(distributed).distributed, 1);
});

it("never counts missing required carry stages or unexplained cache non-attempts", () => {
  for (const name of ["selection", "verification", "apply", "rerere", "cache-export"]) {
    const partial = requireOutcomeReceipts(
      clean.filter((row) => row.kind !== "stage" || row.stage !== name),
    );
    assert.strictEqual(outcomeStreak(partial).noAgentCarry, 0, `missing ${name}`);
  }
  const unexplained = requireOutcomeReceipts(
    clean.map((row) => {
      if (row.kind !== "stage" || row.notApplicableReason === undefined) return row;
      const { notApplicableReason: _reason, ...unproven } = row;
      return unproven;
    }),
  );
  assert.strictEqual(outcomeStreak(unexplained).noAgentCarry, 0);
  const carried = requireOutcomeReceipts(
    clean.map((row) =>
      row.kind === "stage" && row.notApplicableReason ? stage(row.stage, "succeeded") : row,
    ),
  );
  assert.strictEqual(outcomeStreak(carried).noAgentCarry, 1);
  const incomplete: ReadonlyArray<OutcomeReceipt> = [
    attempt("partial"),
    stage("selection", "succeeded", { attemptId: "partial" }),
    stage("verification", "succeeded", { attemptId: "partial", sha: C }),
  ];
  for (let count = 1; count <= incomplete.length; count += 1) {
    assert.strictEqual(
      outcomeStreak(requireOutcomeReceipts([...clean, ...incomplete.slice(0, count)])).noAgentCarry,
      0,
      `partial attempt with ${count - 1} stages`,
    );
  }
  const earlier = clean.filter(
    (row) => row.kind !== "stage" || !["rerere", "cache-export"].includes(row.stage),
  );
  const later = clean.map((row) =>
    row.kind === "attempt" || row.kind === "stage" ? { ...row, attemptId: "later" } : row,
  );
  assert.strictEqual(
    outcomeStreak(requireOutcomeReceipts([...earlier, ...later])).noAgentCarry,
    0,
    "later completion cannot erase missing earlier cache evidence",
  );
  const earlierWrongVerification = clean.map((row) =>
    row.kind === "stage" && row.stage === "verification" ? { ...row, sha: D } : row,
  );
  assert.strictEqual(
    outcomeStreak(requireOutcomeReceipts([...earlierWrongVerification, ...later])).noAgentCarry,
    0,
    "every apply needs matching verification",
  );
});

it("records direct clean replay cache non-applicability explicitly", () => {
  const result: AutoRebaseResult = {
    schemaVersion: 1,
    mode: "on",
    dryRun: false,
    status: "advanced",
    oldSha: B,
    baseSha: B,
    target: target.target,
    newSha: C,
    stableCandidates: [],
    verificationDependencySetup: [],
    decision: { pairwiseFirstConflict: null, census: null, censusUnavailableReason: null },
    blocked: null,
  };
  const rows = autoOutcomeReceipts([target, attempt()], result);
  assert.strictEqual(outcomeStreak(rows).noAgentCarry, 1);
  for (const name of ["rerere", "cache-export"]) {
    assert.strictEqual(
      rows.find((row) => row.kind === "stage" && row.stage === name)?.kind,
      "stage",
    );
  }
});

it("retains blocked eligible targets and mode changes without rewriting eligibility", () => {
  const blocked = [
    target,
    attempt("candidate", { mode: "candidate" }),
    stage("selection", "blocked", { attemptId: "candidate" }),
  ];
  const recovered = requireOutcomeReceipts([...blocked, ...clean]);
  assert.strictEqual(outcomeStreak(recovered).eligibleTargets, 1);
  assert.strictEqual(outcomeStreak(recovered).noAgentCarry, 0);
  assert.strictEqual(summarizeOutcomes(recovered)[0]?.attempts.length, 2);
  assert.throws(
    () => requireOutcomeReceipts([...blocked, { ...target, eligible: false }]),
    /conflicting immutable/,
  );
});

it("distinguishes manual kickoff from autonomous agent execution", () => {
  const receipts = requireOutcomeReceipts(
    clean.map((row) =>
      row.kind === "attempt" ? attempt("sync/1", { trigger: "manual", executor: "agent" }) : row,
    ),
  );
  assert.strictEqual(summarizeOutcomes(receipts)[0]?.agentRecovered, true);
  assert.strictEqual(summarizeOutcomes(receipts)[0]?.attempts[0]?.trigger, "manual");
  assert.strictEqual(outcomeStreak(receipts).noAgentCarry, 0);
});

it("deduplicates exact delivery and refuses changed terminal evidence", () => {
  assert.deepStrictEqual(requireOutcomeReceipts([...clean, ...clean]), clean);
  assert.throws(
    () => requireOutcomeReceipts([...clean, stage("apply", "failed")]),
    /conflicting immutable/,
  );
  assert.throws(() => requireOutcomeReceipts([attempt(), target]), /eligibility/);
});

it("canonicalizes target groups without changing their internal receipt order", () => {
  const older = {
    ...target,
    target: { tag: "v0.0.39-nightly.20260903.1273", sha: D },
  };
  const olderAttempt = attempt("history", {
    targetSha: D,
    trigger: "unknown",
    executor: "unknown",
    mode: "unknown",
  });
  const olderStage = stage("apply", "unknown", { targetSha: D, attemptId: "history" });
  const canonical = canonicalizeOutcomeReceipts(
    [...clean, ...release(), older, olderAttempt, olderStage],
    (left, right) => (left.target.sha === D ? -1 : right.target.sha === D ? 1 : 0),
  );

  assert.deepStrictEqual(
    canonical.filter((row) => row.kind === "target").map((row) => row.target.tag),
    [older.target.tag, target.target.tag],
  );
  assert.deepStrictEqual(canonical.slice(0, 3), [older, olderAttempt, olderStage]);
  assert.strictEqual(outcomeStreak(canonical).noAgentCarry, 1);
  assert.strictEqual(outcomeStreak(canonical).distributed, 1);
});

it("validates every target pair before sorting", () => {
  const targets = [
    target,
    { ...target, target: { tag: "v1-nightly.2", sha: B } },
    { ...target, target: { tag: "v1-nightly.3", sha: D } },
  ];
  const order = [D, B, A];
  const compared = new Set<string>();
  canonicalizeOutcomeReceipts(targets, (left, right) => {
    compared.add([left.target.sha, right.target.sha].toSorted().join(":"));
    return order.indexOf(left.target.sha) - order.indexOf(right.target.sha);
  });

  assert.strictEqual(compared.size, 3);
});

it("retains the first tag and explicitly reconciles aliases without creating another target", () => {
  const renamed = { ...target, target: { ...target.target, tag: "v1-stable" } };
  assert.throws(() => requireOutcomeReceipts([...clean, renamed]), /target-alias/);
  const alias = {
    kind: "target-alias",
    targetSha: A,
    tag: renamed.target.tag,
    reason: "stable tag points at the already selected nightly commit",
  } as const;
  const reconciled = requireOutcomeReceipts([...clean, alias, renamed, attempt("later")]);
  assert.strictEqual(outcomeStreak(reconciled).eligibleTargets, 1);
  assert.deepStrictEqual(summarizeOutcomes(reconciled)[0]?.target, target.target);
  assert.deepStrictEqual(summarizeOutcomes(reconciled)[0]?.aliases, [alias]);
});

it("records published report plus failed policy without inventing apply or release", () => {
  const blockedTarget = {
    ...target,
    target: {
      tag: "v0.0.39-nightly.20260905.1284",
      sha: "9cb40178a53cca279c67a9079afab3cddf6b6ddb",
    },
  };
  const blockedAttempt = attempt("33947820483/1/rebase", {
    targetSha: blockedTarget.target.sha,
    sourceSha: "38c60b61e4edc594aa2963cfc294469313612b4f",
    trigger: "push",
    runUrl: "https://github.com/RSI-Software/t3code-hyprws/actions/runs/33947820483",
  });
  const result: AutoRebaseResult = {
    schemaVersion: 1,
    mode: "on",
    dryRun: false,
    status: "no-op",
    oldSha: blockedAttempt.sourceSha,
    baseSha: B,
    target: null,
    newSha: null,
    stableCandidates: [],
    verificationDependencySetup: [],
    decision: { pairwiseFirstConflict: null, census: null, censusUnavailableReason: null },
    blocked: {
      newestUpstreamTagBeyondWindow: blockedTarget.target.tag,
    } as AutoRebaseResult["blocked"],
  };
  const rows = autoOutcomeReceipts([blockedTarget, blockedAttempt], result, {
    publication: "succeeded",
    policy: "failed",
    url: "https://github.com/RSI-Software/t3code-hyprws/issues/568#issuecomment-5549329372",
  });
  const stages = summarizeOutcomes(rows)[0]!.stages;
  assert.strictEqual(stages.find((row) => row.stage === "selection")?.status, "blocked");
  assert.strictEqual(stages.find((row) => row.stage === "report-publication")?.status, "succeeded");
  assert.strictEqual(stages.find((row) => row.stage === "report-policy")?.status, "failed");
  assert.strictEqual(stages.find((row) => row.stage === "apply")?.status, "not-attempted");
  assert.isFalse(
    stages.some((row) => row.stage.startsWith("release") || row.stage === "distribution"),
  );
});

const syncReport = (state: SyncReport["stage"]): SyncReport => ({
  schemaVersion: 1,
  stage: state,
  repositoryRoot: "/fixture",
  reportPath: "/fixture/report.json",
  recordPath: "/fixture/record.md",
  issue: { number: 1, title: "fixture", blockingSha: A },
  candidates: [target.target],
  target: target.target,
  source: { sha: B, sharedBase: A, expectedOld: B },
  botCarried: true,
  conflicts: [],
  verification: [],
  installedHead: C,
  ciHead: C,
  rererePublication: { state: "pending", error: "cache lease failed" },
});
it("retains durable apply with pending cache but never mistakes a checked lane for apply", () => {
  const applied = summarizeOutcomes(syncOutcomeReceipts(syncReport("applied"), "carry"))[0]!;
  assert.strictEqual(applied.appliedSha, C);
  assert.strictEqual(applied.stages.find((row) => row.stage === "rerere")?.status, "pending");
  assert.strictEqual(
    summarizeOutcomes(syncOutcomeReceipts(syncReport("checked"), "check"))[0]?.appliedSha,
    null,
  );
});

it("retains a failed manual verification without claiming a trunk apply", () => {
  const rows = syncOutcomeReceipts(syncReport("checked"), "manual-check", {
    phase: "unblock-check",
    detail: "hyprws CI failed for the selected lane",
  });
  const outcome = summarizeOutcomes(rows)[0]!;
  assert.strictEqual(outcome.stages.find((row) => row.stage === "verification")?.status, "failed");
  assert.strictEqual(outcome.appliedSha, null);
  assert.strictEqual(outcome.noAgentCarry, false);
});

it("keeps release failure visible and resumes release without another rebase", () => {
  const failed = requireOutcomeReceipts([
    ...clean,
    ...release({ build: "failed", publication: "not-attempted" }),
  ]);
  assert.strictEqual(summarizeOutcomes(failed)[0]?.resume, "release-only");
  const recovered = requireOutcomeReceipts([...failed, ...release({ attemptId: "release/2" })]);
  assert.strictEqual(summarizeOutcomes(recovered)[0]?.resume, "complete");
  assert.strictEqual(
    summarizeOutcomes(recovered)[0]?.stages.filter((row) => row.stage === "apply").length,
    1,
  );
  assert.strictEqual(summarizeOutcomes(recovered)[0]?.attempts.length, 3);
  assert.strictEqual(
    summarizeOutcomes(recovered)[0]?.stages.find(
      (row) => row.stage === "release-build" && row.attemptId === "release/1",
    )?.status,
    "failed",
  );
  const laterFailure = requireOutcomeReceipts([
    ...recovered,
    ...release({
      attemptId: "release/3",
      releasedSha: D,
      tagSha: D,
      build: "failed",
      publication: "not-attempted",
      interveningCommits: [D],
    }),
  ]);
  assert.strictEqual(summarizeOutcomes(laterFailure)[0]?.resume, "release-only");
  const unchanged = requireOutcomeReceipts([
    ...recovered,
    ...release({
      attemptId: "schedule-no-changes",
      build: "not-attempted",
      publication: "not-attempted",
    }),
  ]);
  assert.strictEqual(summarizeOutcomes(unchanged)[0]?.resume, "complete");
});

it("requires exact release SHA, intervening verified commits and complete published assets", () => {
  const partial = requireOutcomeReceipts([
    ...clean,
    ...release({
      publishedAssets: [{ name: "app.AppImage", size: 10, digest: `sha256:${"a".repeat(64)}` }],
    }),
  ]);
  assert.isFalse(summarizeOutcomes(partial)[0]!.distributed);
  const mismatch = requireOutcomeReceipts([...clean, ...release({ tagSha: D })]);
  assert.isFalse(summarizeOutcomes(mismatch)[0]!.distributed);
  const advanced = requireOutcomeReceipts([
    ...clean,
    ...release({ releasedSha: D, tagSha: D, interveningCommits: [B, D] }),
  ]);
  assert.strictEqual(summarizeOutcomes(advanced)[0]?.appliedSha, C);
  assert.strictEqual(summarizeOutcomes(advanced)[0]?.releasedSha, D);
  assert.throws(
    () => requireOutcomeReceipts([...clean, ...release({ releasedSha: D, tagSha: D })]),
    /released-tree/,
  );
  assert.throws(
    () =>
      requireOutcomeReceipts([
        ...clean,
        ...release().filter((row) => row.kind !== "stage" || row.stage !== "release-build"),
      ]),
    /release-build/,
  );
  const forged = release().map((row) =>
    row.kind === "stage" && row.distribution
      ? {
          ...row,
          distribution: {
            ...row.distribution,
            publishedAssets: row.distribution.publishedAssets.map((asset) => ({
              ...asset,
              digest: "unknown",
            })),
          },
        }
      : row,
  );
  assert.throws(() => requireOutcomeReceipts([...clean, ...forged]), /released-tree/);
});

it("never counts unknown historical evidence as automatic success", () => {
  assert.strictEqual(outcomeStreak(parseChurnState("[]").outcomes).noAgentCarry, 0);
  const unknown = requireOutcomeReceipts([
    target,
    attempt("history", { trigger: "unknown", executor: "unknown", mode: "unknown" }),
    stage("apply", "unknown", { attemptId: "history" }),
  ]);
  assert.strictEqual(outcomeStreak(unknown).eligibleTargets, 1);
  assert.strictEqual(outcomeStreak(unknown).noAgentCarry, 0);
  assert.strictEqual(outcomeStreak(unknown).distributed, 0);
});

it("retains explicit exclusions without removing blocked or rewritten eligible targets", () => {
  const excluded = {
    ...target,
    target: { tag: "excluded", sha: D },
    eligible: false,
    reason: "outside the supported tag policy",
  };
  const rows = requireOutcomeReceipts([
    ...clean,
    excluded,
    { ...target, target: { tag: "next", sha: D.replaceAll("d", "e") } },
    attempt("rewrite", {
      targetSha: "e".repeat(40),
      rewriteProvenance: "https://example.test/rewrite",
    }),
    stage("selection", "blocked", { targetSha: "e".repeat(40), attemptId: "rewrite" }),
  ]);
  assert.strictEqual(outcomeStreak(rows).eligibleTargets, 2);
  assert.strictEqual(outcomeStreak(rows).noAgentCarry, 0);
});

// The outcome executor's fork-hook reapply stage, against a real conflicted index in a temp repo
// (the keep-both fixture pattern from `scripts/lib/fork-conflict-outcomes.test.ts`). Git commands
// run against the system; only the lane's scoped typecheck is stubbed, since the fixture content
// is synthetic.

/** Delegates git to the system and answers `vp` with the canned typecheck result. */
const typecheckRunner = (typecheck: CommandResult): CommandRunner => {
  const system = new SystemCommandRunner();
  return {
    run: (command, args, cwd, input, env) =>
      command === "vp" ? typecheck : system.run(command, args, cwd ?? ".", input, env),
  };
};

/** Stage the three rebase index stages for one path, exactly as a conflicted replay leaves them. */
const stageReapplyConflict = (
  root: string,
  path: string,
  contents: { readonly base: string; readonly ours: string; readonly theirs: string },
): void => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  const entries = ([1, 2, 3] as const)
    .map((stage) => {
      const value = stage === 1 ? contents.base : stage === 2 ? contents.ours : contents.theirs;
      const sha = NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: root,
        input: value,
      })
        .toString()
        .trim();
      return `100644 ${sha} ${stage}\t${path}`;
    })
    .join("\n");
  NodeChildProcess.execFileSync("git", ["update-index", "--index-info"], {
    cwd: root,
    input: `${entries}\n`,
  });
};

const MARKED_HOOK = "upstream-fixes/settings-patch-field";
const HOOK_LINE = `  restoreSymlinks: boolean; // fork-hook: ${MARKED_HOOK}\n`;
const FORK_TAIL = `export const fsf = 1; // fork-hook: ${MARKED_HOOK}\n`;
// Upstream rewrites the base `rename` line the fork keeps, with a fork addition right beside it:
// one conflicted hunk with base content (keep-both declines) whose direction is "upstream", plus
// an EOF co-insertion hunk whose direction is null, so moved-deletion declines on the mixture and
// the reapply stage runs.
const settingsStages = (forkAfterRename: string, forkTail: string) => ({
  base: "export interface ServerSettingsPatch {\n  rename: string;\n}\n\nexport const tail = 0;\n",
  ours: "export interface ServerSettingsPatch {\n  name: string;\n  mount: boolean;\n}\n\nexport const tail = 0;\nexport const up = 1;\n",
  theirs: `export interface ServerSettingsPatch {\n  rename: string;\n${forkAfterRename}}\n\nexport const tail = 0;\n${forkTail}`,
});

it("keeps the keep-both stop when the fork hunk carries woven unmarked lines", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-reapply-test-"));
  NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: root });
  const path = "packages/contracts/src/settings.ts";
  try {
    // One marked hook line plus one woven, unmarked fork line in the same rewritten hunk: the
    // reapply stage must not resolve, or the woven line would be silently dropped.
    stageReapplyConflict(
      root,
      path,
      settingsStages(
        `  restoreSymlinks: boolean; // fork-hook: ${MARKED_HOOK}\n  wovenHelper();\n`,
        FORK_TAIL,
      ),
    );
    const outcome = executeConflictOutcome(
      typecheckRunner({ status: 0, stdout: "", stderr: "" }),
      root,
      path,
    );
    assert.isTrue(isUnresolved(outcome));
    if (!isUnresolved(outcome)) return;
    // The stop is keep-both's, unchanged — the walk record names the keep-both seam, not a reapply.
    assert.include(outcome.reason, "rewrote the same lines");
    assert.notInclude(outcome.reason, "fork-hook reapply");
    // Nothing was written or staged.
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, path)));
    assert.strictEqual(
      NodeChildProcess.execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: root,
      })
        .toString()
        .trim(),
      path,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("re-applies a marked fork hook into the merged upstream text of a real conflicted index", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-reapply-test-"));
  NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: root });
  const path = "packages/contracts/src/settings.ts";
  const runner = typecheckRunner({ status: 0, stdout: "", stderr: "" });
  try {
    stageReapplyConflict(root, path, settingsStages(HOOK_LINE, FORK_TAIL));
    const outcome = executeConflictOutcome(runner, root, path);
    assert.isFalse(isUnresolved(outcome));
    if (isUnresolved(outcome)) return;
    assert.strictEqual(outcome.source, "hook-reapply");
    assert.strictEqual(outcome.conflictClass, "mechanical");
    assert.include(outcome.resolution, MARKED_HOOK);
    assert.deepStrictEqual(outcome.reinsertedHooks, [MARKED_HOOK]);
    const resolved = NodeFS.readFileSync(NodePath.join(root, path), "utf8");
    // The upstream line stands and the hook line sits inside the collection, marker exactly once.
    assert.include(resolved, "  mount: boolean;");
    assert.strictEqual(resolved.split(`fork-hook: ${MARKED_HOOK}`).length - 1, 1);
    // The hook line (the last marker for the key) sits inside the collection, before its brace.
    assert.include(resolved, `  export const fsf = 1; // fork-hook: ${MARKED_HOOK}\n}\n`);
    // Staged, so `git rebase --continue` sees a resolved path and not a dirty tree.
    assert.strictEqual(
      NodeChildProcess.execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: root,
      })
        .toString()
        .trim(),
      "",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a conflicted stop when the fork text marks only a different hook", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-reapply-test-"));
  NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: root });
  const path = "packages/contracts/src/settings.ts";
  try {
    // The fork side's addition is marked, but for another manifest entry: this path's hook has no
    // readable marker, so the reapply refuses even though the fork-side guard let the seam through.
    stageReapplyConflict(
      root,
      path,
      settingsStages(
        "  restoreSymlinks: boolean; // fork-hook: upstream-fixes/wfs-fork-import\n",
        "export const probe = 1; // fork-hook: upstream-fixes/settings-row-import\n",
      ),
    );
    const outcome = executeConflictOutcome(
      typecheckRunner({ status: 0, stdout: "", stderr: "" }),
      root,
      path,
    );
    assert.isTrue(isUnresolved(outcome));
    if (!isUnresolved(outcome)) return;
    assert.include(outcome.reason, "fork-hook reapply refused");
    assert.include(outcome.reason, MARKED_HOOK);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses the re-insertion when the lane's scoped typecheck fails afterwards", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-reapply-test-"));
  NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: root });
  const path = "packages/contracts/src/settings.ts";
  try {
    stageReapplyConflict(root, path, settingsStages(HOOK_LINE, FORK_TAIL));
    const outcome = executeConflictOutcome(
      typecheckRunner({ status: 1, stdout: "", stderr: "TS2304: cannot find name" }),
      root,
      path,
    );
    assert.isTrue(isUnresolved(outcome));
    if (!isUnresolved(outcome)) return;
    assert.include(outcome.reason, MARKED_HOOK);
    assert.include(outcome.reason, "typecheck");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
