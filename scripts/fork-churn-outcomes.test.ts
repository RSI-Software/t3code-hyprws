// @effect-diagnostics nodeBuiltinImport:off - Exercise the receipt CLI against isolated Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { readChurnState } from "./fork-churn-ledger.ts";
import { CHURN_REF, CHURN_LEDGER_FILE, writeBotRefFile } from "./lib/fork-bot-refs.ts";
import type { summarizeOutcomes } from "./lib/fork-sync-outcomes.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const cli = NodePath.join(import.meta.dirname, "fork-churn.ts");
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decode = (value: string) =>
  (decodeJson(value) as { outcomes: ReturnType<typeof summarizeOutcomes> }).outcomes[0]!;

it.layer(NodeServices.layer)("outcome CLI", (it) => {
  it.effect(
    "imports idempotently, preserves legacy state, refuses conflicts and verifies release-only retries",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-outcomes-" });
        const git = (args: ReadonlyArray<string>) =>
          NodeChildProcess.execFileSync("git", [...args], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        const write = Effect.fn("writeOutcomeFixture")(function* (path: string, value: unknown) {
          yield* fs.writeFileString(NodePath.join(root, path), yield* encode(value));
        });
        git(["init", "--initial-branch=fixture"]);
        git(["config", "user.name", "Fixture"]);
        git(["config", "user.email", "fixture@example.invalid"]);
        git(["commit", "--allow-empty", "-m", "upstream"]);
        const targetSha = git(["rev-parse", "HEAD"]);
        git(["tag", "v1-nightly.1"]);
        git(["commit", "--allow-empty", "-m", "applied fork"]);
        const appliedSha = git(["rev-parse", "HEAD"]);
        git(["commit", "--allow-empty", "-m", "verified repair"]);
        const releasedSha = git(["rev-parse", "HEAD"]);
        git(["tag", "v1-hyprws-nightly.1"]);
        writeBotRefFile(
          root,
          CHURN_REF,
          CHURN_LEDGER_FILE,
          '{"version":2,"walks":[],"seamRecords":[]}\n',
          "legacy seed",
        );
        const target = {
          kind: "target",
          target: { tag: "v1-nightly.1", sha: targetSha },
          eligible: true,
          reason: "selected tagged target under the fork tag policy",
        };
        const attempt = {
          kind: "attempt",
          targetSha,
          attemptId: "sync",
          sourceSha: targetSha,
          trigger: "schedule",
          executor: "bot",
          mode: "on",
          runUrl: "https://example.test/sync",
        };
        const apply = {
          kind: "stage",
          targetSha,
          attemptId: "sync",
          stage: "apply",
          status: "succeeded",
          sha: appliedSha,
          detail: "retained leased apply",
        };
        const verification = { ...apply, stage: "verification", detail: "retained verification" };
        const receipts = [target, attempt, verification, apply];
        yield* write("input.json", { version: 1, receipts });
        const env = {
          ...process.env,
          GITHUB_EVENT_NAME: "schedule",
          GITHUB_RUN_ID: "42",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_JOB: "outcome",
          FORK_OUTCOME_EXPORT: NodePath.join(root, "retained.json"),
        };
        const run = (args: ReadonlyArray<string>, overrides: Record<string, string> = {}) =>
          NodeChildProcess.spawnSync(process.execPath, [cli, ...args], {
            cwd: root,
            env: { ...env, ...overrides },
            encoding: "utf8",
          });
        const first = run(["outcome", "--input", "input.json"]);
        assert.strictEqual(first.status, 0, first.stderr);
        const recorded = git(["rev-parse", CHURN_REF]);
        assert.strictEqual(run(["outcome", "--input", "input.json"]).status, 0);
        assert.strictEqual(git(["rev-parse", CHURN_REF]), recorded);
        assert.strictEqual(readChurnState(root).version, 3);
        yield* write("input.json", {
          version: 1,
          receipts: [target, attempt, { ...apply, status: "failed" }],
        });
        const conflict = run(["outcome", "--input", "input.json"]);
        assert.strictEqual(conflict.status, 1);
        assert.include(conflict.stderr, "conflicting immutable");
        assert.strictEqual(git(["rev-parse", CHURN_REF]), recorded);
        assert.strictEqual(run(["outcome", "--input", "input.json", "--release"]).status, 2);
        assert.strictEqual(run(["outcome", "--unknown"]).status, 2);
        assert.strictEqual(run(["--help"]).status, 0);

        yield* fs.makeDirectory(NodePath.join(root, "bin"));
        const ghPath = NodePath.join(root, "bin", "gh");
        yield* fs.writeFileString(
          ghPath,
          "#!/usr/bin/env node\nprocess.stdout.write(process.env.RELEASE_FIXTURE_ASSETS);\n",
        );
        yield* fs.chmod(ghPath, 0o755);
        const needs = {
          preflight: {
            result: "success",
            outputs: {
              ref: releasedSha,
              tag: "v1-hyprws-nightly.1",
              version: "1-hyprws-nightly.1",
            },
          },
          build: {
            result: "success",
            outputs: { expected_assets: '["app.AppImage","latest-linux.yml"]' },
          },
          release: { result: "success" },
        };
        const assets = [
          { name: "app.AppImage", size: 20, digest: `sha256:${"a".repeat(64)}` },
          { name: "latest-linux.yml", size: 10, digest: `sha256:${"b".repeat(64)}` },
        ];
        const releaseEnv = {
          PATH: `${NodePath.join(root, "bin")}:${process.env.PATH}`,
          FORK_RELEASE_NEEDS: yield* encode(needs),
          RELEASE_FIXTURE_ASSETS: yield* encode({ assets: assets.slice(0, 1) }),
        };
        const failed = run(["outcome", "--release"], releaseEnv);
        assert.strictEqual(failed.status, 0, failed.stderr);
        assert.strictEqual(decode(failed.stdout).resume, "release-only");
        const retry = run(["outcome", "--release"], {
          ...releaseEnv,
          GITHUB_RUN_ATTEMPT: "2",
          RELEASE_FIXTURE_ASSETS: yield* encode({ assets }),
        });
        assert.strictEqual(retry.status, 0, retry.stderr);
        const result = decode(retry.stdout);
        assert.strictEqual(result.resume, "complete");
        assert.strictEqual(result.appliedSha, appliedSha);
        assert.strictEqual(result.releasedSha, releasedSha);
        assert.strictEqual(
          result.stages.filter((row: { stage: string }) => row.stage === "apply").length,
          1,
        );
        const distribution = result.stages.findLast(
          (row) => row.stage === "distribution",
        )!.distribution!;
        assert.deepStrictEqual(distribution.interveningCommits, [releasedSha]);
        assert.strictEqual(distribution.verifiedSha, releasedSha);
        assert.isTrue(yield* fs.exists(NodePath.join(root, "retained.json")));
        const report = {
          schemaVersion: 1,
          stage: "conflicts",
          repositoryRoot: root,
          reportPath: NodePath.join(root, "sync-report.json"),
          recordPath: NodePath.join(root, "record.md"),
          issue: { number: 1, title: "retained stop", blockingSha: targetSha },
          candidates: [target.target],
          target: target.target,
          source: { sha: appliedSha, sharedBase: targetSha, expectedOld: appliedSha },
          botCarried: true,
          conflicts: [],
          verification: [],
          installedHead: releasedSha,
        };
        yield* write("sync-report.json", report);
        const stopped = run(["outcome", "--sync-report", "sync-report.json"]);
        assert.strictEqual(stopped.status, 0, stopped.stderr);
        const stoppedAttempt = decode(stopped.stdout).attempts.at(-1)!;
        assert.strictEqual(
          decode(stopped.stdout).stages.find(
            (row) => row.attemptId === stoppedAttempt.attemptId && row.stage === "verification",
          )?.status,
          "blocked",
        );
        yield* write("sync-report.json", {
          ...report,
          stage: "applied",
          ciHead: releasedSha,
          rererePublication: { state: "published" },
        });
        const resumed = run(["outcome", "--sync-report", "sync-report.json"], {
          FORK_OUTCOME_CACHE_EXPORT: "success",
        });
        assert.strictEqual(resumed.status, 0, resumed.stderr);
        const resumedOutcome = decode(resumed.stdout);
        assert.strictEqual(resumedOutcome.appliedSha, releasedSha);
        assert.notStrictEqual(resumedOutcome.attempts.at(-1)!.attemptId, stoppedAttempt.attemptId);
        assert.strictEqual(
          resumedOutcome.stages.find(
            (row) => row.attemptId === stoppedAttempt.attemptId && row.stage === "verification",
          )?.status,
          "blocked",
        );
        const retained = git(["rev-parse", CHURN_REF]);
        assert.strictEqual(
          run(["outcome", "--sync-report", "sync-report.json"], {
            FORK_OUTCOME_CACHE_EXPORT: "success",
          }).status,
          0,
        );
        assert.strictEqual(git(["rev-parse", CHURN_REF]), retained);
      }),
  );
});
