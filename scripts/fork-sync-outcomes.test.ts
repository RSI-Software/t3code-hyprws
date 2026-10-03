import { assert, it } from "@effect/vitest";
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
