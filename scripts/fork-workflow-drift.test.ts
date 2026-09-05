// @effect-diagnostics nodeBuiltinImport:off - Git blob fixtures have no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";

import {
  buildScanResult,
  renderScanReport,
  scanFailures,
  scanFailureSummary,
} from "./fork-scan.ts";
import {
  parseWorkflowReviews,
  readWorkflowDrift,
  releaseOutcomeExportProblem,
  WORKFLOW_COPIES,
  WORKFLOW_REVIEWS_PATH,
} from "./lib/fork-workflow-drift.ts";

const blob = (text: string): string =>
  NodeCrypto.createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");

// The prerequisite added by upstream 498ab9c399d5e8c3097a286be14d03238e071ac1.
// The fork copy has a different path, so a same-path overlap scan misses it.
const before = `jobs:
  check:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    steps:
      - name: Test
        run: vp run test
`;
const after = before.replace(
  "      - name: Test",
  `      - name: Install browser secret helper build libraries
        run: sudo apt-get update && sudo apt-get install -y libsecret-1-dev pkg-config
      - name: Test`,
);
const forkBefore = before.replace("blacksmith-4vcpu-ubuntu-2404", "ubuntu-latest");
const forkAfter = after.replace("blacksmith-4vcpu-ubuntu-2404", "ubuntu-latest");
const upstreamCommit = "a".repeat(40);

const releaseWorkflow = NodeFS.readFileSync(
  new URL("../.github/workflows/hyprws-release.yml", import.meta.url),
  "utf8",
);

const fixture = (
  options: {
    upstream?: string;
    fork?: string;
    reviewedUpstream?: string;
    reviewedFork?: string;
    disposition?: "adapted" | "no-change";
    reason?: string;
  } = {},
) => {
  const reviews = WORKFLOW_COPIES.map((pair) => ({
    ...pair,
    upstreamCommit,
    upstreamBlob: blob(options.reviewedUpstream ?? before),
    forkBlob: blob(options.reviewedFork ?? forkBefore),
    disposition: options.disposition ?? "adapted",
    reason: options.reason ?? "Use GitHub runners; preserve equivalent test steps.",
  }));
  const git = {
    run: (args: ReadonlyArray<string>): string => {
      if (args[0] === "show" && args[1] === `HEAD:${WORKFLOW_REVIEWS_PATH}`)
        return JSON.stringify({ version: 1, reviews });
      if (args[0] === "rev-parse") {
        const [ref, path] = (args[1] ?? "").split(":");
        const pair = WORKFLOW_COPIES.find(
          ({ upstream, fork }) => upstream === path || fork === path,
        );
        if (pair !== undefined) {
          if (ref === upstreamCommit) return blob(options.reviewedUpstream ?? before);
          if (ref === "target") return blob(options.upstream ?? after);
          if (ref === "HEAD") return blob(options.fork ?? forkBefore);
        }
      }
      throw new Error(`unexpected Git read: ${args.join(" ")}`);
    },
  };
  return { git, reviews };
};

const scan = (git: ReturnType<typeof fixture>["git"]) => ({
  ...buildScanResult({
    // Replayed head has no remaining same-path overlap against its target.
    base: "target",
    target: "target",
    head: "HEAD",
    commits: [],
    filesBySha: new Map(),
    scans: new Map(),
    forkChanged: new Set(),
    upstreamChanged: new Set(),
  }),
  workflowDrift: readWorkflowDrift(git, "HEAD", "target"),
});

it("blocks libsecret drift for both copied workflows even after a clean replay", () => {
  const result = scan(fixture().git);
  assert.isEmpty(result.overlaps);
  assert.lengthOf(scanFailures(result), 2);
  assert.include(scanFailures(result)[0]!, "ci.yml -> .github/workflows/hyprws-ci.yml");
  assert.include(scanFailures(result)[1]!, "release.yml -> .github/workflows/hyprws-release.yml");
  assert.include(scanFailureSummary(result)[0]!, "2 workflow drift gap(s)");
  assert.include(renderScanReport(result), "upstream workflow changed since review");
});

it("accepts reviewed adaptations and catches the next upstream-only step", () => {
  const reviewed = {
    upstream: after,
    reviewedUpstream: after,
    fork: forkAfter,
    reviewedFork: forkAfter,
  };
  assert.isEmpty(scanFailures(scan(fixture(reviewed).git)));
  const next = scan(
    fixture({ ...reviewed, upstream: after + "      - run: install-next-prerequisite\n" }).git,
  );
  assert.lengthOf(scanFailures(next), 2);
});

it("accepts a reasoned no-change for upstream-only platform publishing", () => {
  const windows = after + "  windows-signing:\n    runs-on: windows-latest\n";
  const result = scan(
    fixture({
      upstream: windows,
      reviewedUpstream: windows,
      fork: forkAfter,
      reviewedFork: forkAfter,
      disposition: "no-change",
      reason: "Upstream Windows signing is outside the fork Linux x64 AppImage release channel.",
    }).git,
  );
  assert.isEmpty(scanFailures(result));
  assert.include(renderScanReport(result), "no-change");
  assert.include(renderScanReport(result), "Linux x64 AppImage");
});

it("invalidates fork-only edits until their rationale and fingerprint are refreshed", () => {
  const changed = forkAfter + "  permissions: read\n";
  const options = {
    upstream: after,
    reviewedUpstream: after,
    fork: changed,
    reviewedFork: forkAfter,
  };
  assert.include(
    scanFailures(scan(fixture(options).git))[0]!,
    "fork counterpart changed since review",
  );
  assert.isEmpty(scanFailures(scan(fixture({ ...options, reviewedFork: changed }).git)));
});

it("refuses absent, malformed, duplicate and unreasoned reviews", () => {
  const { git, reviews } = fixture({ upstream: before });
  const missing = {
    run: (args: ReadonlyArray<string>) =>
      args[0] === "show" ? '{"version":1,"reviews":[]}' : git.run(args),
  };
  assert.lengthOf(scanFailures(scan(missing)), 2);
  assert.throws(() => parseWorkflowReviews('{"version":2,"reviews":[]}'));
  assert.throws(
    () => parseWorkflowReviews(JSON.stringify({ version: 1, reviews: [...reviews, reviews[0]] })),
    /duplicate/,
  );
  assert.throws(
    () =>
      parseWorkflowReviews(
        JSON.stringify({ version: 1, reviews: [{ ...reviews[0], reason: " " }] }),
      ),
    /reason/,
  );
  assert.throws(
    () =>
      parseWorkflowReviews(
        JSON.stringify({ version: 1, reviews: [{ ...reviews[0], upstreamBlob: "short" }] }),
      ),
    /full Git/,
  );
});

it("refuses provenance that names a different upstream blob", () => {
  const { git } = fixture({ upstream: before });
  const wrong = {
    run: (args: ReadonlyArray<string>) =>
      args[1]?.startsWith(upstreamCommit + ":")
        ? blob("different upstream history")
        : git.run(args),
  };
  assert.include(scanFailures(scan(wrong))[0]!, "provenance does not match");
});

it("keeps the release outcome export scoped to its collector and upload path", () => {
  assert.isUndefined(releaseOutcomeExportProblem(releaseWorkflow));

  assert.match(
    releaseOutcomeExportProblem(
      releaseWorkflow.replace("FORK_OUTCOME_EXPORT:", "FORK_OUTCOME_EXPROT:"),
    )!,
    /declared once/,
  );
  assert.match(
    releaseOutcomeExportProblem(
      releaseWorkflow.replace(
        "          FORK_OUTCOME_EXPORT: ${{ runner.temp }}/${{ env.FORK_RELEASE_OUTCOME_FILE }}\n",
        "      FORK_OUTCOME_EXPORT: ${{ runner.temp }}/${{ env.FORK_RELEASE_OUTCOME_FILE }}\n",
      ),
    )!,
    /Retain release outcome env/,
  );
  assert.match(
    releaseOutcomeExportProblem(
      releaseWorkflow.replace(
        "            ${{ runner.temp }}/${{ env.FORK_RELEASE_OUTCOME_FILE }}\n",
        "            ${{ runner.temp }}/other-release-outcome.json\n",
      ),
    )!,
    /must use the FORK_OUTCOME_EXPORT path/,
  );
});
