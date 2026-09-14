import { assert, it } from "@effect/vitest";

import {
  carryFeasibility,
  encodeFeasibilityArtifact,
  FeasibilityArtifactError,
  parseFeasibilityArtifact,
} from "./fork-feasibility-artifact.ts";
import { MergeTreeMemo, type ForkRebaseFeasibility } from "./fork-rebase-feasibility.ts";

const SOURCE = "1".repeat(40);
const TARGET = "2".repeat(40);
const BASE = "3".repeat(40);
const TREE = "4".repeat(40);

const key = { sourceSha: SOURCE, targetSha: TARGET, baseSha: BASE };

const feasibility: ForkRebaseFeasibility = {
  ffBoundary: {
    upstreamCommitCount: 2,
    cleanCommitCount: 1,
    firstConflict: {
      sha: TARGET,
      shortSha: TARGET.slice(0, 7),
      subject: "fix: upstream",
      tags: [],
    },
    changes: [
      {
        sha: TARGET,
        shortSha: TARGET.slice(0, 7),
        subject: "fix: upstream",
        tags: ["v1.0.0"],
        filesAdded: ["shared.txt"],
      },
    ],
  },
  conflicts: [
    {
      path: "shared.txt",
      hunkCount: 1,
      introducingForkCommit: {
        sha: SOURCE,
        shortSha: SOURCE.slice(0, 7),
        subject: "feat(test): fork change",
        domain: "fork-meta",
        tier: "qol",
      },
    },
  ],
  overlap: {
    upstreamChanged: 2,
    forkChanged: 1,
    overlap: 1,
    hardConflict: 1,
    automerged: [],
  },
};

const artifact = (): ReturnType<typeof parseFeasibilityArtifact> => {
  const memo = new MergeTreeMemo([
    { left: SOURCE, right: TARGET, tree: TREE, conflicts: ["shared.txt"] },
  ]);
  return parseFeasibilityArtifact(
    encodeFeasibilityArtifact("vp run fork:rebase-report", key, feasibility, memo),
  );
};

it("round-trips a walk and its merge memo", () => {
  const parsed = artifact();
  assert.deepStrictEqual(parsed.feasibility, feasibility);
  assert.deepStrictEqual(parsed.mergeTree, [
    { left: SOURCE, right: TARGET, tree: TREE, conflicts: ["shared.txt"] },
  ]);
  assert.strictEqual(parsed.generatedBy, "vp run fork:rebase-report");
});

it("refuses an artifact that is not a feasibility walk", () => {
  assert.throws(() => parseFeasibilityArtifact("{"), FeasibilityArtifactError);
  assert.throws(
    () => parseFeasibilityArtifact(JSON.stringify({ schemaVersion: 2 })),
    FeasibilityArtifactError,
  );
  const broken = JSON.parse(
    encodeFeasibilityArtifact("vp run fork:rebase-report", key, feasibility, new MergeTreeMemo()),
  ) as Record<string, unknown>;
  broken.sourceSha = "not-a-sha";
  assert.throws(() => parseFeasibilityArtifact(JSON.stringify(broken)), FeasibilityArtifactError);
});

it("takes a carried walk only while every sha it was computed against still matches", () => {
  const carried = carryFeasibility(artifact(), key);
  assert.deepStrictEqual(carried.feasibility, feasibility);
  assert.strictEqual(carried.refusal, null);
});

it("refuses a moved walk but keeps its merge memo", () => {
  const moved = "5".repeat(40);
  const carried = carryFeasibility(artifact(), { ...key, targetSha: moved });
  assert.strictEqual(carried.feasibility, null);
  assert.match(carried.refusal ?? "", /^targetSha 222222222222 is now 555555555555$/);
  assert.deepStrictEqual(carried.memo.entries(), [
    { left: SOURCE, right: TARGET, tree: TREE, conflicts: ["shared.txt"] },
  ]);
});

it("reports every sha that moved", () => {
  const carried = carryFeasibility(artifact(), {
    sourceSha: "6".repeat(40),
    targetSha: "7".repeat(40),
    baseSha: BASE,
  });
  assert.strictEqual(carried.feasibility, null);
  assert.strictEqual(
    carried.refusal,
    "sourceSha 111111111111 is now 666666666666, targetSha 222222222222 is now 777777777777",
  );
});

it("counts carried merges apart from the ones a walk runs", () => {
  const memo = new MergeTreeMemo([
    { left: SOURCE, right: TARGET, tree: TREE, conflicts: ["shared.txt"] },
  ]);
  const git = {
    runResult: () => ({ status: 0, stdout: `${TREE}\n`, stderr: "" }),
  };
  memo.resolve(git, SOURCE, TARGET);
  memo.resolve(git, SOURCE, BASE);
  memo.resolve(git, SOURCE, BASE);
  assert.strictEqual(memo.carried, 1);
  assert.strictEqual(memo.computed, 1);
  assert.strictEqual(memo.repeats, 1);
});

it("offers nothing when no artifact was carried", () => {
  const carried = carryFeasibility(null, key);
  assert.strictEqual(carried.feasibility, null);
  assert.strictEqual(carried.refusal, null);
  assert.deepStrictEqual(carried.memo.entries(), []);
});
