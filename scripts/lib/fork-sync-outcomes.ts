/** Immutable sync evidence. Missing stages and legacy walks never imply success. */
export const OUTCOME_STAGES = [
  "selection",
  "verification",
  "apply",
  "rerere",
  "cache-export",
  "report-publication",
  "report-policy",
  "release-verification",
  "release-build",
  "distribution",
] as const;
export type OutcomeStage = (typeof OUTCOME_STAGES)[number];
export type OutcomeStatus =
  | "succeeded"
  | "failed"
  | "blocked"
  | "pending"
  | "not-attempted"
  | "unknown";
export interface OutcomeTarget {
  readonly kind: "target";
  readonly target: { readonly tag: string; readonly sha: string };
  readonly eligible: boolean;
  readonly reason: string;
}
export interface OutcomeAttempt {
  readonly kind: "attempt";
  readonly targetSha: string;
  readonly attemptId: string;
  readonly trigger: "schedule" | "push" | "manual" | "unknown";
  readonly executor: "bot" | "agent" | "human" | "unknown";
  readonly mode: "on" | "candidate" | "off" | "unknown";
  readonly sourceSha: string;
  readonly runUrl: string;
  readonly rewriteProvenance?: string;
}
export interface OutcomeTargetAlias {
  readonly kind: "target-alias";
  readonly targetSha: string;
  readonly tag: string;
  readonly reason: string;
}
export interface PublishedAsset {
  readonly name: string;
  readonly size: number;
  readonly digest: string;
}
export interface DistributionEvidence {
  readonly appliedSha: string;
  readonly releasedSha: string;
  readonly version: string;
  readonly tag: string;
  readonly tagSha: string | null;
  readonly expectedAssets: ReadonlyArray<string>;
  readonly publishedAssets: ReadonlyArray<PublishedAsset>;
  readonly interveningCommits: ReadonlyArray<string>;
  /** A passing verification of the exact released tree covers these intervening commits. */
  readonly verifiedSha: string;
  readonly verificationUrl: string;
}
export interface OutcomeStageReceipt {
  readonly kind: "stage";
  readonly targetSha: string;
  readonly attemptId: string;
  readonly stage: OutcomeStage;
  readonly status: OutcomeStatus;
  readonly sha?: string;
  readonly detail: string;
  readonly evidenceUrl?: string;
  readonly distribution?: DistributionEvidence;
  readonly notApplicableReason?: "direct-clean-rebase";
}
export type OutcomeReceipt =
  | OutcomeTarget
  | OutcomeTargetAlias
  | OutcomeAttempt
  | OutcomeStageReceipt;

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid outcome object");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error("invalid outcome text");
  return value;
};
const sha = (value: unknown): string => {
  const result = text(value);
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error("outcome evidence requires a full SHA");
  return result;
};
const choice = <T extends string>(value: unknown, values: ReadonlyArray<T>): T => {
  if (!values.includes(value as T)) throw new Error(`invalid outcome choice: ${String(value)}`);
  return value as T;
};
const array = (value: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error("invalid outcome array");
  return value;
};
const exact = (value: Record<string, unknown>, keys: ReadonlyArray<string>) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("unknown outcome field");
};
const distribution = (value: unknown): DistributionEvidence => {
  const row = object(value);
  exact(row, [
    "appliedSha",
    "releasedSha",
    "version",
    "tag",
    "tagSha",
    "expectedAssets",
    "publishedAssets",
    "interveningCommits",
    "verifiedSha",
    "verificationUrl",
  ]);
  const expectedAssets = array(row.expectedAssets).map(text);
  if (new Set(expectedAssets).size !== expectedAssets.length)
    throw new Error("duplicate expected asset");
  const publishedAssets = array(row.publishedAssets).map((value) => {
    const asset = object(value);
    exact(asset, ["name", "size", "digest"]);
    if (!Number.isSafeInteger(asset.size) || Number(asset.size) <= 0)
      throw new Error("invalid published asset size");
    return { name: text(asset.name), size: Number(asset.size), digest: text(asset.digest) };
  });
  if (new Set(publishedAssets.map((asset) => asset.name)).size !== publishedAssets.length)
    throw new Error("duplicate published asset");
  return {
    appliedSha: sha(row.appliedSha),
    releasedSha: sha(row.releasedSha),
    version: text(row.version),
    tag: text(row.tag),
    tagSha: row.tagSha === null ? null : sha(row.tagSha),
    expectedAssets,
    publishedAssets,
    interveningCommits: array(row.interveningCommits).map(sha),
    verifiedSha: sha(row.verifiedSha),
    verificationUrl: text(row.verificationUrl),
  };
};
export const requireOutcomeReceipt = (value: unknown): OutcomeReceipt => {
  const row = object(value);
  if (row.kind === "target") {
    exact(row, ["kind", "target", "eligible", "reason"]);
    const target = object(row.target);
    exact(target, ["tag", "sha"]);
    if (typeof row.eligible !== "boolean") throw new Error("outcome eligibility must be declared");
    return {
      kind: "target",
      target: { tag: text(target.tag), sha: sha(target.sha) },
      eligible: row.eligible,
      reason: text(row.reason),
    };
  }
  if (row.kind === "attempt") {
    exact(row, [
      "kind",
      "targetSha",
      "attemptId",
      "trigger",
      "executor",
      "mode",
      "sourceSha",
      "runUrl",
      "rewriteProvenance",
    ]);
    return {
      kind: "attempt",
      targetSha: sha(row.targetSha),
      attemptId: text(row.attemptId),
      trigger: choice(row.trigger, ["schedule", "push", "manual", "unknown"]),
      executor: choice(row.executor, ["bot", "agent", "human", "unknown"]),
      mode: choice(row.mode, ["on", "candidate", "off", "unknown"]),
      sourceSha: sha(row.sourceSha),
      runUrl: text(row.runUrl),
      ...(row.rewriteProvenance === undefined
        ? {}
        : { rewriteProvenance: text(row.rewriteProvenance) }),
    };
  }
  if (row.kind === "target-alias") {
    exact(row, ["kind", "targetSha", "tag", "reason"]);
    return {
      kind: "target-alias",
      targetSha: sha(row.targetSha),
      tag: text(row.tag),
      reason: text(row.reason),
    };
  }
  if (row.kind !== "stage") throw new Error("invalid outcome receipt kind");
  exact(row, [
    "kind",
    "targetSha",
    "attemptId",
    "stage",
    "status",
    "sha",
    "detail",
    "evidenceUrl",
    "distribution",
    "notApplicableReason",
  ]);
  const receipt: OutcomeStageReceipt = {
    kind: "stage",
    targetSha: sha(row.targetSha),
    attemptId: text(row.attemptId),
    stage: choice(row.stage, OUTCOME_STAGES),
    status: choice(row.status, [
      "succeeded",
      "failed",
      "blocked",
      "pending",
      "not-attempted",
      "unknown",
    ]),
    detail: text(row.detail),
    ...(row.sha === undefined ? {} : { sha: sha(row.sha) }),
    ...(row.evidenceUrl === undefined ? {} : { evidenceUrl: text(row.evidenceUrl) }),
    ...(row.distribution === undefined ? {} : { distribution: distribution(row.distribution) }),
    ...(row.notApplicableReason === undefined
      ? {}
      : { notApplicableReason: choice(row.notApplicableReason, ["direct-clean-rebase"]) }),
  };
  if (
    receipt.notApplicableReason !== undefined &&
    (receipt.status !== "not-attempted" || !["rerere", "cache-export"].includes(receipt.stage))
  )
    throw new Error("cache non-applicability requires an unattempted cache stage");
  if (
    ["verification", "apply", "release-verification", "release-build"].includes(receipt.stage) &&
    receipt.status === "succeeded" &&
    receipt.sha === undefined
  )
    throw new Error("successful stage requires its actual SHA");
  if (receipt.stage === "distribution" && receipt.status === "succeeded") {
    const evidence = receipt.distribution;
    if (
      evidence === undefined ||
      evidence.expectedAssets.length === 0 ||
      evidence.verifiedSha !== evidence.releasedSha ||
      receipt.sha !== evidence.releasedSha ||
      evidence.tagSha !== evidence.releasedSha ||
      evidence.expectedAssets.some(
        (name) =>
          !evidence.publishedAssets.some(
            (asset) => asset.name === name && /^sha256:[a-f0-9]{64}$/.test(asset.digest),
          ),
      ) ||
      new Set(evidence.interveningCommits).size !== evidence.interveningCommits.length ||
      (evidence.appliedSha === evidence.releasedSha && evidence.interveningCommits.length !== 0) ||
      (evidence.appliedSha !== evidence.releasedSha &&
        evidence.interveningCommits.at(-1) !== evidence.releasedSha)
    ) {
      throw new Error(
        "distribution success requires complete assets and exact released-tree verification",
      );
    }
  }
  return receipt;
};

const key = (receipt: OutcomeReceipt): string =>
  receipt.kind === "target"
    ? `target:${receipt.target.sha}`
    : receipt.kind === "target-alias"
      ? `alias:${receipt.targetSha}:${receipt.tag}`
      : `${receipt.kind}:${receipt.targetSha}:${receipt.attemptId}${receipt.kind === "stage" ? `:${receipt.stage}` : ""}`;

/** Preserve declaration order; duplicate delivery is harmless, changed evidence refuses. */
export const requireOutcomeReceipts = (value: unknown): ReadonlyArray<OutcomeReceipt> => {
  const receipts = new Map<string, OutcomeReceipt>();
  for (const candidate of array(value)) {
    const receipt = requireOutcomeReceipt(candidate);
    const id = key(receipt);
    const previous = receipts.get(id);
    if (
      previous?.kind === "target" &&
      receipt.kind === "target" &&
      previous.target.tag !== receipt.target.tag
    ) {
      if (!receipts.has(`alias:${receipt.target.sha}:${receipt.target.tag}`))
        throw new Error(
          `target tag changed; explicitly record target-alias evidence for ${receipt.target.tag} at ${receipt.target.sha}`,
        );
      if (previous.eligible !== receipt.eligible || previous.reason !== receipt.reason)
        throw new Error(`conflicting immutable outcome eligibility: ${id}`);
      continue;
    }
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(receipt))
      throw new Error(`conflicting immutable outcome evidence: ${id}`);
    if (receipt.kind !== "target" && !receipts.has(`target:${receipt.targetSha}`))
      throw new Error("declare target eligibility before recording attempts");
    if (
      receipt.kind === "stage" &&
      !receipts.has(`attempt:${receipt.targetSha}:${receipt.attemptId}`)
    )
      throw new Error("declare the attempt before recording a stage");
    if (
      receipt.kind === "stage" &&
      receipt.stage === "distribution" &&
      receipt.status === "succeeded"
    ) {
      if (
        ![...receipts.values()].some(
          (item) =>
            item.kind === "stage" &&
            item.targetSha === receipt.targetSha &&
            item.stage === "apply" &&
            item.status === "succeeded" &&
            item.sha === receipt.distribution?.appliedSha,
        )
      )
        throw new Error("distribution does not link a retained apply receipt");
      for (const stage of ["release-verification", "release-build"] as const) {
        const proof = receipts.get(`stage:${receipt.targetSha}:${receipt.attemptId}:${stage}`);
        if (
          proof?.kind !== "stage" ||
          proof.status !== "succeeded" ||
          proof.sha !== receipt.distribution?.releasedSha
        )
          throw new Error(`distribution requires retained ${stage} for its exact released SHA`);
      }
    }
    receipts.set(id, receipt);
  }
  return [...receipts.values()];
};

const targetSha = (receipt: OutcomeReceipt): string =>
  receipt.kind === "target" ? receipt.target.sha : receipt.targetSha;

/**
 * Keep each target's validated receipt history intact while placing target groups in their
 * authoritative upstream order. The caller owns that order because only a Git-aware boundary can
 * distinguish tag creation order from commit ancestry.
 */
export const canonicalizeOutcomeReceipts = (
  value: unknown,
  compareTargets: (left: OutcomeTarget, right: OutcomeTarget) => number,
): ReadonlyArray<OutcomeReceipt> => {
  const receipts = requireOutcomeReceipts(value);
  const declaredTargets = receipts.filter(
    (receipt): receipt is OutcomeTarget => receipt.kind === "target",
  );
  const comparisons = new Map<OutcomeTarget, Map<OutcomeTarget, number>>();
  for (const [index, left] of declaredTargets.entries()) {
    for (const right of declaredTargets.slice(index + 1)) {
      const order = Math.sign(compareTargets(left, right));
      if (order === 0 || !Number.isFinite(order))
        throw new Error(
          `outcome targets do not have one strict order: ${left.target.tag} and ${right.target.tag}`,
        );
      comparisons.set(left, new Map([...(comparisons.get(left) ?? []), [right, order]]));
      comparisons.set(right, new Map([...(comparisons.get(right) ?? []), [left, -order]]));
    }
  }
  const targets = declaredTargets.toSorted((left, right) => {
    if (left === right) return 0;
    const order = comparisons.get(left)?.get(right);
    if (order === undefined) throw new Error("outcome target comparison is missing");
    return order;
  });
  const rank = new Map(targets.map((target, index) => [target.target.sha, index]));
  const receiptRank = (receipt: OutcomeReceipt): number => {
    const value = rank.get(targetSha(receipt));
    if (value === undefined) throw new Error("outcome receipt has no target rank");
    return value;
  };
  return receipts.toSorted((left, right) => receiptRank(left) - receiptRank(right));
};

export const summarizeOutcomes = (receipts: ReadonlyArray<OutcomeReceipt>) => {
  const targets = receipts.filter((receipt): receipt is OutcomeTarget => receipt.kind === "target");
  return targets.map((target) => {
    const attempts = receipts.filter(
      (row): row is OutcomeAttempt => row.kind === "attempt" && row.targetSha === target.target.sha,
    );
    const stages = receipts.filter(
      (row): row is OutcomeStageReceipt =>
        row.kind === "stage" && row.targetSha === target.target.sha,
    );
    const applied = stages.findLast((row) => row.stage === "apply" && row.status === "succeeded");
    const latestDistribution = stages.findLast((row) => row.stage === "distribution");
    const lastSuccess = stages.findLast(
      (row) => row.stage === "distribution" && row.status === "succeeded",
    );
    const retainedDistribution =
      latestDistribution?.status === "not-attempted" &&
      latestDistribution.sha === lastSuccess?.distribution?.releasedSha
        ? lastSuccess
        : latestDistribution;
    const distributed =
      retainedDistribution?.status === "succeeded" &&
      retainedDistribution.distribution?.appliedSha === applied?.sha
        ? retainedDistribution
        : undefined;
    const applyAttempt = attempts.find((row) => row.attemptId === applied?.attemptId);
    const carryStages = stages.filter((row) =>
      ["selection", "verification", "apply", "rerere", "cache-export"].includes(row.stage),
    );
    const carryAttempts = attempts.filter(
      (attempt) =>
        carryStages.some((row) => row.attemptId === attempt.attemptId) ||
        !stages.some(
          (row) =>
            row.attemptId === attempt.attemptId &&
            ["release-verification", "release-build", "distribution"].includes(row.stage),
        ),
    );
    const completeCarryAttempt = (id: string): boolean => {
      const receipt = (name: OutcomeStage) =>
        carryStages.find((row) => row.attemptId === id && row.stage === name);
      const selection = receipt("selection"),
        verification = receipt("verification"),
        apply = receipt("apply");
      if (!selection || !verification || !apply) return false;
      if (apply.status === "not-attempted") return true;
      if (
        selection.status !== "succeeded" ||
        verification.status !== "succeeded" ||
        apply.status !== "succeeded" ||
        verification.sha !== apply.sha
      )
        return false;
      return (["rerere", "cache-export"] as const).every((name) => {
        const cache = receipt(name);
        return (
          cache?.status === "succeeded" ||
          (cache?.status === "not-attempted" && cache.notApplicableReason === "direct-clean-rebase")
        );
      });
    };
    const noAgentCarry =
      applied !== undefined &&
      applyAttempt?.executor === "bot" &&
      applyAttempt.mode === "on" &&
      carryAttempts.every(
        (row) =>
          row.executor === "bot" &&
          row.mode === "on" &&
          row.trigger !== "manual" &&
          row.trigger !== "unknown" &&
          completeCarryAttempt(row.attemptId),
      ) &&
      !carryStages.some((row) => ["failed", "blocked", "unknown", "pending"].includes(row.status));
    const aliases = receipts.filter(
      (row): row is OutcomeTargetAlias =>
        row.kind === "target-alias" && row.targetSha === target.target.sha,
    );
    return {
      target: target.target,
      aliases,
      eligible: target.eligible,
      reason: target.reason,
      attempts,
      stages,
      appliedSha: applied?.sha ?? null,
      releasedSha: distributed?.distribution?.releasedSha ?? null,
      noAgentCarry,
      agentRecovered: applied !== undefined && applyAttempt?.executor === "agent",
      distributed: distributed !== undefined,
      resume:
        applied === undefined ? "sync" : distributed === undefined ? "release-only" : "complete",
    };
  });
};

/** Canonical eligible order includes blocked and rewritten targets; exclusion never changes rows. */
export const outcomeStreak = (receipts: ReadonlyArray<OutcomeReceipt>) => {
  const eligible = summarizeOutcomes(receipts).filter((row) => row.eligible);
  let noAgentCarry = 0;
  let distributed = 0;
  for (const row of eligible.toReversed()) {
    if (!row.noAgentCarry) break;
    noAgentCarry += 1;
  }
  for (const row of eligible.toReversed()) {
    if (!row.distributed) break;
    distributed += 1;
  }
  return { eligibleTargets: eligible.length, noAgentCarry, distributed, outcomes: eligible };
};
