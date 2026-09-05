// @effect-diagnostics nodeBuiltinImport:off - Verify object-only construction in isolated Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { execute, rewriteBindingMatches, type CommandRunner } from "./fork-sync.ts";
import { readReport, renderRecord } from "./fork-sync-state.ts";
import { syncOutcomeReceipts } from "./fork-churn-outcomes.ts";
import { outcomeStreak, requireOutcomeReceipts } from "./lib/fork-sync-outcomes.ts";
import { writeBotRefFile, CHURN_REF, CHURN_LEDGER_FILE } from "./lib/fork-bot-refs.ts";
import {
  buildRewrite,
  parseRewriteManifest,
  rebuildCommit,
  RewriteObjects,
  verifyRewriteBuild,
  type RewriteManifest,
} from "./lib/fork-rewrite-build.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const redirectedConfig = {
  GIT_CONFIG: "/dev/null",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "remote.review.promisor",
  GIT_CONFIG_VALUE_0: "true",
};
const decodeCliError = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ exitCode: Schema.Number })),
);
const decodeCliResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ result: Schema.String, receiptPath: Schema.String })),
);
const decodeTraceEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ event: Schema.String, argv: Schema.optional(Schema.Array(Schema.String)) }),
  ),
);

const git = (root: string, args: ReadonlyArray<string>, input?: string): string =>
  NodeChildProcess.execFileSync("git", [...args], { cwd: root, input, encoding: "utf8" }).trim();
const fixture = Effect.fn("rewriteFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "rewrite-build-" });
  const root = NodePath.join(directory, "repo");
  yield* fs.makeDirectory(root);
  git(root, ["init", "--quiet", "--initial-branch=fixture"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  yield* fs.makeDirectory(NodePath.join(root, ".github/workflows"), { recursive: true });
  yield* fs.writeFileString(
    NodePath.join(root, ".github/workflows/hyprws-upstream-sync.yml"),
    "on:\n  schedule:\n    - cron: '23 * * * *'\n",
  );
  yield* fs.writeFileString(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  yield* fs.writeFileString(NodePath.join(root, "main.ts"), "export const upstream = 1;\n");
  yield* fs.makeDirectory(NodePath.join(root, "ordered"));
  yield* fs.writeFileString(NodePath.join(root, "ordered/file"), "nested\n");
  yield* fs.writeFileString(NodePath.join(root, "ordered.ext"), "sibling\n");
  yield* fs.symlink("main.ts", NodePath.join(root, "linked"));
  git(root, ["add", "."]);
  git(root, ["update-index", "--chmod=+x", "ordered/file"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  const baseTag = "v0.0.39-nightly.20260904.1280";
  git(root, ["tag", baseTag]);
  yield* fs.writeFileString(
    NodePath.join(root, "main.ts"),
    "export const upstream = 1;\nexport const fork = 2;\n",
  );
  git(root, ["add", "."]);
  git(root, [
    "commit",
    "--quiet",
    "-m",
    "feat: original\n\nFork-Domain: fork-meta\nFork-Tier: core",
  ]);
  const original = git(root, ["rev-parse", "HEAD"]),
    tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  yield* fs.writeFileString(
    NodePath.join(root, "main.ts"),
    "export const upstream = 1;\nexport { fork } from './policy.fork';\n",
  );
  yield* fs.writeFileString(NodePath.join(root, "policy.fork.ts"), "export const fork = 2;\n");
  git(root, ["add", "."]);
  git(root, [
    "commit",
    "--quiet",
    "-m",
    "refactor: boundary\n\nFork-Domain: fork-meta\nFork-Tier: core",
  ]);
  const source = git(root, ["rev-parse", "HEAD"]),
    sourceTree = git(root, ["rev-parse", "HEAD^{tree}"]);
  git(root, ["update-ref", "refs/remotes/origin/hyprws", source]);
  const objects = new RewriteObjects(root),
    before = objects.entries(tree),
    after = objects.entries(sourceTree);
  const manifest: RewriteManifest = {
    schema: "fork.rewrite-manifest.v1",
    source,
    sourceTree,
    base,
    baseTag,
    proofs: ["snapshot-tests", "composition", "test-ownership", "compatibility"].map((name) => ({
      name,
      sha256: "a".repeat(64),
    })),
    unresolved: [],
    slots: [
      {
        commit: original,
        tree,
        resultTree: sourceTree,
        readSet: [...after.keys()].map((path) => ({ path, entry: before.get(path) ?? null })),
        changes: [...after].map(([path, entry]) => ({
          path,
          before: before.get(path) ?? null,
          after: entry,
          reason: "reviewed extraction at original slot",
        })),
      },
      { commit: source, tree: sourceTree, resultTree: sourceTree, readSet: [], changes: [] },
    ],
  };
  return { fs, root, directory, manifest, objects };
});

it("preserves arbitrary message bytes and metadata while removing only invalid signatures", () => {
  const tree = "a".repeat(40),
    parent = "b".repeat(40);
  const raw = Buffer.concat([
    Buffer.from(
      `tree ${tree}\nparent ${parent}\nauthor A <a@b> 123 +1245\ncommitter C <c@d> 456 -0330\ngpgsig -----BEGIN SIGNATURE-----\n opaque\n -----END SIGNATURE-----\n\n`,
    ),
    Buffer.from([0xff, 0x0a, 0x00, 0xfe]),
  ]);
  assert.isTrue(rebuildCommit(raw, tree, parent).bytes.equals(raw));
  const changed = rebuildCommit(raw, "c".repeat(40), parent);
  assert.isTrue(changed.bytes.subarray(-4).equals(raw.subarray(-4)));
  assert.include(
    changed.bytes.toString("latin1"),
    "author A <a@b> 123 +1245\ncommitter C <c@d> 456 -0330",
  );
  assert.notInclude(changed.bytes.toString(), "gpgsig");
  assert.match(changed.removedSignatureSha256!, /^[a-f0-9]{64}$/);
  assert.throws(
    () =>
      rebuildCommit(
        Buffer.from(raw.toString("latin1").replace("gpgsig", "mergetag"), "latin1"),
        tree,
        parent,
      ),
    /unsupported commit metadata/,
  );
});

it.layer(NodeServices.layer)("rewrite-build", (it) => {
  it.effect(
    "carries a constructed nightly rewrite through check, independent review and the exact apply lease",
    () =>
      Effect.gen(function* () {
        const { root, directory, fs, manifest } = yield* fixture();
        const manifestPath = NodePath.join(directory, "manifest.json"),
          receiptPath = `${manifestPath}.receipt.json`;
        const raw = Buffer.from(encodeJson(manifest)),
          receipt = buildRewrite(root, raw);
        yield* fs.writeFile(manifestPath, raw);
        yield* fs.writeFileString(receiptPath, encodeJson(receipt));
        git(root, ["update-ref", "refs/remotes/upstream/main", manifest.base]);
        const declaration = {
          kind: "target" as const,
          target: { tag: manifest.baseTag, sha: manifest.base },
          eligible: true,
          reason: "retained historical eligibility",
        };
        writeBotRefFile(
          root,
          CHURN_REF,
          CHURN_LEDGER_FILE,
          encodeJson({ version: 3, walks: [], seamRecords: [], outcomes: [declaration] }),
          "fixture ledger",
        );
        git(root, ["checkout", "--quiet", "--detach", receipt.result]);
        const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
        let reviewer = false,
          movedMarker = false;
        const blocker = "f".repeat(40);
        const runner: CommandRunner = {
          run(command, args, cwd, input, env) {
            calls.push({ command, args });
            const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
            if (command === "git") {
              if (args.includes("push")) return ok();
              if (args.includes("ls-remote")) return ok(`${receipt.result}\t${args.at(-1)}\n`);
              const result = NodeChildProcess.spawnSync(command, [...args], {
                cwd,
                input,
                env,
                encoding: "utf8",
              });
              return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
            }
            if (command === "wt") return ok(encodeJson({ path: root }));
            if (command === "vp") return ok();
            if (command === "ghb")
              return ok(
                encodeJson({
                  schema: "ghb.host-handoff.v1",
                  host: reviewer
                    ? {
                        role: "host",
                        iface: "claude",
                        provider: "anthropic",
                        model: "claude-opus-4-6",
                        session: "independent-review",
                      }
                    : {
                        role: "host",
                        iface: "codex",
                        provider: "openai",
                        model: "gpt-6-astra",
                        session: "walking-host",
                      },
                }),
              );
            if (command === "gh" && args[0] === "variable") return ok("candidate");
            if (command === "gh" && args[0] === "issue" && args[1] === "list")
              return ok(
                encodeJson([
                  {
                    number: 568,
                    title: "blocked",
                    body: `<!-- blocking-sha:${movedMarker ? manifest.source : blocker} -->`,
                  },
                ]),
              );
            if (command === "gh" && args[0] === "issue" && args[1] === "comment")
              return ok("https://example.test/issues/568#issuecomment-1");
            if (command === "gh" && args[0] === "issue" && args[1] === "view") return ok();
            if (command === "gh" && args[0] === "run" && args[1] === "list")
              return ok(
                encodeJson(
                  args.includes("hyprws-ci.yml")
                    ? [
                        {
                          databaseId: 42,
                          headSha: receipt.result,
                          status: "completed",
                          conclusion: "success",
                          url: "https://example.test/ci/42",
                        },
                      ]
                    : [],
                ),
              );
            throw new Error(`unexpected fixture command: ${command} ${args.join(" ")}`);
          },
        };
        const copiedManifest = NodePath.join(root, ".git/copied-manifest.json");
        yield* fs.writeFile(copiedManifest, raw);
        yield* fs.writeFileString(`${copiedManifest}.receipt.json`, encodeJson(receipt));
        const symlinkManifest = NodePath.join(directory, "symlink-manifest.json");
        yield* fs.symlink(manifestPath, symlinkManifest);
        yield* fs.writeFileString(`${symlinkManifest}.receipt.json`, encodeJson(receipt));
        for (const replacement of [copiedManifest, symlinkManifest])
          assert.throws(
            () =>
              execute(
                [
                  "rewrite-rehearse",
                  "--from",
                  receipt.result,
                  "--manifest",
                  replacement,
                  "--issue",
                  "568",
                ],
                root,
                runner,
              ),
            /outside the repository|regular external files/,
          );
        const replayed = execute(
          [
            "rewrite-rehearse",
            "--from",
            receipt.result,
            "--manifest",
            manifestPath,
            "--issue",
            "568",
          ],
          root,
          runner,
        );
        assert.strictEqual(replayed.issue.blockingSha, blocker);
        assert.deepStrictEqual(replayed.target, declaration.target);
        assert.isTrue(rewriteBindingMatches(replayed, receipt));
        assert.isFalse(rewriteBindingMatches({ ...replayed, botCarried: true }, receipt));
        assert.isFalse(rewriteBindingMatches({ ...replayed, originalCount: 999 }, receipt));
        const checked = execute(["unblock-check", "--report", replayed.reportPath], root, runner);
        assert.strictEqual(checked.installedHead, receipt.result);
        assert.isTrue(
          calls.some(
            (call) =>
              call.command === "vp" &&
              call.args.includes("fork:scan") &&
              call.args.includes(manifest.baseTag),
          ),
        );
        assert.throws(
          () =>
            execute(
              ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
              root,
              runner,
            ),
          /independent review is missing/,
        );
        assert.throws(
          () => execute(["unblock-auto", "--resume", "--report", checked.reportPath], root, runner),
          /walk stopped/,
        );
        assert.include(
          yield* fs.readFileString(checked.recordPath),
          "## Nightly independent review",
        );
        assert.throws(
          () =>
            execute(["unblock-review", "--report", checked.reportPath, "--sign-off"], root, runner),
          /requires Claude Opus/,
        );
        reviewer = true;
        movedMarker = true;
        assert.throws(
          () =>
            execute(["unblock-review", "--report", checked.reportPath, "--sign-off"], root, runner),
          /blocking marker is stale/,
        );
        movedMarker = false;
        const reviewed = execute(
          ["unblock-review", "--report", checked.reportPath, "--sign-off"],
          root,
          runner,
        );
        assert.strictEqual(reviewed.nightlyReview?.status, "signed-off");
        for (const replacement of [copiedManifest, symlinkManifest]) {
          const relocated = {
            ...reviewed,
            rewrite: {
              ...reviewed.rewrite,
              build: {
                ...reviewed.rewrite!.build,
                manifestPath: replacement,
                receiptPath: `${replacement}.receipt.json`,
              },
            },
          };
          for (const argv of [
            ["unblock-check", "--report", reviewed.reportPath],
            ["unblock-review", "--report", reviewed.reportPath, "--sign-off"],
            ["unblock-apply", "--report", reviewed.reportPath, "--record", reviewed.recordPath],
          ]) {
            yield* fs.writeFileString(
              reviewed.reportPath,
              encodeJson({
                ...relocated,
                stage: argv[0] === "unblock-check" ? "replayed" : "checked",
                nightlyReview: argv[0] === "unblock-review" ? undefined : relocated.nightlyReview,
              }),
            );
            assert.throws(
              () => execute(argv, root, runner),
              /outside the repository|regular external files/,
            );
          }
        }
        yield* fs.writeFileString(reviewed.reportPath, encodeJson(reviewed));
        const originalRecord = yield* fs.readFileString(reviewed.recordPath);
        yield* fs.writeFileString(
          reviewed.recordPath,
          originalRecord.replace("Build manifest SHA-256", "Tampered manifest"),
        );
        assert.throws(
          () =>
            execute(
              ["unblock-apply", "--report", reviewed.reportPath, "--record", reviewed.recordPath],
              root,
              runner,
            ),
          /stale/,
        );
        yield* fs.writeFileString(reviewed.recordPath, originalRecord);
        const applied = execute(
          ["unblock-apply", "--report", reviewed.reportPath, "--record", reviewed.recordPath],
          root,
          runner,
        );
        assert.strictEqual(applied.stage, "applied");
        const pushes = calls.filter(
          (call) => call.command === "git" && call.args.includes(`HEAD:refs/heads/hyprws`),
        );
        assert.lengthOf(pushes, 1);
        assert.include(pushes[0]!.args, `--force-with-lease=refs/heads/hyprws:${manifest.source}`);
        execute(
          ["unblock-apply", "--report", applied.reportPath, "--record", applied.recordPath],
          root,
          runner,
        );
        assert.lengthOf(
          calls.filter(
            (call) => call.command === "git" && call.args.includes(`HEAD:refs/heads/hyprws`),
          ),
          1,
        );
        const receipts = syncOutcomeReceipts(applied, "rewrite/1");
        assert.deepStrictEqual(receipts[0], declaration);
        assert.include(
          receipts.find((row) => row.kind === "attempt")!.rewriteProvenance!,
          receipt.manifestSha256,
        );
        assert.strictEqual(outcomeStreak(requireOutcomeReceipts(receipts)).noAgentCarry, 0);
        const checkedReceipts = syncOutcomeReceipts(checked, "rewrite/check", {
          phase: "unblock-check",
          detail: "failed CI fixture",
        });
        assert.isTrue(
          checkedReceipts.some(
            (row) =>
              row.kind === "stage" && row.stage === "verification" && row.status === "failed",
          ),
        );
        assert.isFalse(
          checkedReceipts.some(
            (row) => row.kind === "stage" && row.stage === "apply" && row.status === "succeeded",
          ),
        );
        assert.throws(
          () =>
            syncOutcomeReceipts({
              ...checked,
              rewrite: {
                ...checked.rewrite!,
                outcomeTarget: { ...declaration, target: { ...declaration.target, sha: blocker } },
              },
            }),
          /target differs/,
        );
        assert.strictEqual(readReport(applied.reportPath).stage, "applied");
        assert.include(renderRecord(reviewed), receipt.manifestSha256);
      }),
  );
  it.effect(
    "moves a boundary to its original slot, retains an empty cleanup, and changes no refs or index",
    () =>
      Effect.gen(function* () {
        const { root, fs, directory, manifest, objects } = yield* fixture();
        const refs = git(root, ["show-ref"]),
          status = git(root, ["status", "--porcelain"]);
        const index = yield* fs.readFile(NodePath.join(root, ".git/index"));
        const raw = Buffer.from(encodeJson(manifest));
        const receipt = buildRewrite(root, raw);
        assert.notStrictEqual(receipt.result, manifest.source);
        assert.lengthOf(receipt.slots, 2);
        assert.strictEqual(
          git(root, ["rev-list", "--count", `${manifest.base}..${receipt.result}`]),
          "2",
        );
        assert.strictEqual(
          git(root, ["rev-parse", `${receipt.result}^{tree}`]),
          manifest.sourceTree,
        );
        assert.strictEqual(git(root, ["rev-parse", `${receipt.result}^^`]), manifest.base);
        assert.strictEqual(
          git(root, ["rev-parse", `${receipt.result}^:policy.fork.ts`]),
          objects.entries(manifest.sourceTree).get("policy.fork.ts")!.oid,
        );
        assert.strictEqual(
          git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", receipt.result]),
          "",
        );
        assert.strictEqual(
          git(root, ["log", "--reverse", "--format=%B", `${manifest.base}..${receipt.result}`]),
          git(root, ["log", "--reverse", "--format=%B", `${manifest.base}..${manifest.source}`]),
        );
        assert.deepStrictEqual(buildRewrite(root, raw), receipt);
        const manifestPath = NodePath.join(directory, "manifest.json"),
          receiptPath = `${manifestPath}.receipt.json`;
        yield* fs.writeFile(manifestPath, raw);
        yield* fs.writeFileString(receiptPath, encodeJson(receipt));
        assert.deepStrictEqual(verifyRewriteBuild(root, manifestPath, receiptPath), receipt);
        yield* fs.writeFileString(receiptPath, encodeJson({ ...receipt, result: manifest.source }));
        assert.throws(
          () => verifyRewriteBuild(root, manifestPath, receiptPath),
          /receipt does not match/,
        );
        assert.strictEqual(git(root, ["show-ref"]), refs);
        assert.strictEqual(git(root, ["status", "--porcelain"]), status);
        assert.deepStrictEqual(yield* fs.readFile(NodePath.join(root, ".git/index")), index);
      }),
  );

  it.effect("refuses partial/promisor indicators before object retrieval or transport", () =>
    Effect.gen(function* () {
      for (const indicator of [
        "promisor",
        "disabled-promisor",
        "filter",
        "extension",
        "include",
        "marker",
        "alternates",
        "environment",
        "redirected-config",
      ]) {
        const { root, directory, fs, manifest } = yield* fixture();
        const manifestPath = NodePath.join(directory, "manifest.json");
        const tracePath = NodePath.join(directory, "trace.jsonl");
        const raw = Buffer.from(encodeJson(manifest));
        yield* fs.writeFile(manifestPath, raw);
        // If the constructor reaches source traversal, this missing tip can trigger lazy fetch.
        yield* fs.writeFileString(
          NodePath.join(root, ".git/refs/remotes/origin/hyprws"),
          "f".repeat(40) + "\n",
        );
        git(root, ["config", "remote.origin.url", "file:///rewrite-transport-must-not-run"]);
        if (indicator === "promisor" || indicator === "disabled-promisor")
          git(root, [
            "config",
            "remote.origin.promisor",
            indicator === "promisor" ? "true" : "false",
          ]);
        if (indicator === "filter")
          git(root, ["config", "remote.origin.partialCloneFilter", "blob:none"]);
        if (indicator === "extension") git(root, ["config", "extensions.partialClone", "origin"]);
        if (indicator === "include") {
          const included = NodePath.join(directory, "included-config");
          yield* fs.writeFileString(
            included,
            '[remote "cache"]\n partialCloneFilter = blob:none\n',
          );
          git(root, ["config", "include.path", included]);
        }
        if (indicator === "marker")
          yield* fs.writeFileString(
            NodePath.join(root, ".git/objects/pack/pack-fixture.promisor"),
            "",
          );
        if (indicator === "alternates")
          yield* fs.writeFileString(
            NodePath.join(root, ".git/objects/info/alternates"),
            NodePath.join(root, ".git/objects") + "\n",
          );
        const before = git(root, ["count-objects", "-v"]);
        const cli = NodeChildProcess.spawnSync(
          process.execPath,
          [
            NodePath.join(import.meta.dirname, "fork-sync.ts"),
            "rewrite-build",
            "--manifest",
            manifestPath,
            "--json",
          ],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_TRACE2_EVENT: tracePath,
              ...(indicator === "environment"
                ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: NodePath.join(root, ".git/objects") }
                : {}),
              ...(indicator === "redirected-config" ? redirectedConfig : {}),
            },
          },
        );
        assert.strictEqual(cli.status, 3, `${indicator}: ${cli.stdout}\n${cli.stderr}`);
        assert.match(
          cli.stdout,
          /partial\/promisor|promisor object-store|alternate object stores|GIT_CONFIG must be unset/,
        );
        assert.isFalse(yield* fs.exists(`${manifestPath}.receipt.json`));
        if (indicator === "redirected-config") {
          const direct = NodeChildProcess.spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              `import { RewriteObjects } from ${encodeJson(NodePath.join(import.meta.dirname, "lib/fork-rewrite-build.ts"))};
try { new RewriteObjects(process.argv[1]); process.exitCode = 1; }
catch (error) { if (!String(error).includes("GIT_CONFIG must be unset")) throw error; }`,
              root,
            ],
            {
              cwd: root,
              encoding: "utf8",
              env: { ...process.env, ...redirectedConfig, GIT_TRACE2_EVENT: tracePath },
            },
          );
          assert.strictEqual(direct.status, 0, direct.stderr);
          assert.isFalse(
            yield* fs.exists(tracePath),
            "configuration refusal must precede every Git invocation",
          );
          assert.strictEqual(git(root, ["count-objects", "-v"]), before);
          continue;
        }
        const events = (yield* fs.readFileString(tracePath))
          .trim()
          .split("\n")
          .map((line) => decodeTraceEvent(line));
        assert.isFalse(
          events.some((event) => event.event === "child_start"),
          indicator,
        );
        const commands = events
          .filter((event) => event.event === "start")
          .map((event) => event.argv ?? []);
        assert.isAbove(commands.length, 0);
        for (const argv of commands)
          assert.isTrue(
            argv[2] === "config" ||
              (argv[2] === "rev-parse" && argv[3] === "--git-path" && argv[4] === "objects") ||
              (argv[1] === "rev-parse" && argv[2] === "--show-toplevel"),
            `${indicator}: ${argv.join(" ")}`,
          );
        assert.strictEqual(git(root, ["count-objects", "-v"]), before);
        if (indicator !== "environment") {
          assert.throws(
            () => buildRewrite(root, raw, false),
            /partial\/promisor|promisor object-store|alternate object stores/,
          );
          yield* fs.writeFileString(`${manifestPath}.receipt.json`, "{}");
          assert.throws(
            () => verifyRewriteBuild(root, manifestPath, `${manifestPath}.receipt.json`),
            /partial\/promisor|promisor object-store|alternate object stores/,
          );
        }
      }
    }),
  );

  it.effect("refuses unsupported tree shapes before writing constructed objects", () =>
    Effect.gen(function* () {
      for (const shape of ["empty", "control-path"]) {
        const { root, directory, fs, manifest } = yield* fixture();
        const emptyTree = git(root, ["mktree"], "");
        const original = manifest.slots[0]!;
        const extra =
          shape === "empty"
            ? `040000 tree ${emptyTree}\tempty-directory\0`
            : `100644 blob ${git(root, ["rev-parse", `${manifest.source}:main.ts`])}\tcontrol\tpath\0`;
        const tree = git(
          root,
          ["mktree", "-z"],
          git(root, ["ls-tree", "-z", original.tree]) + extra,
        );
        const rewrittenOriginal = git(
          root,
          ["hash-object", "-t", "commit", "-w", "--stdin"],
          git(root, ["cat-file", "commit", original.commit]).replace(
            `tree ${original.tree}`,
            `tree ${tree}`,
          ) + "\n",
        );
        const source = git(
          root,
          ["hash-object", "-t", "commit", "-w", "--stdin"],
          git(root, ["cat-file", "commit", manifest.source]).replace(
            `parent ${original.commit}`,
            `parent ${rewrittenOriginal}`,
          ) + "\n",
        );
        git(root, ["update-ref", "refs/remotes/origin/hyprws", source]);
        const raw = Buffer.from(
          encodeJson({
            ...manifest,
            source,
            slots: [
              { ...original, commit: rewrittenOriginal, tree },
              { ...manifest.slots[1], commit: source },
            ],
          }),
        );
        const manifestPath = NodePath.join(directory, "manifest.json");
        yield* fs.writeFile(manifestPath, raw);
        const before = git(root, ["count-objects", "-v"]);
        assert.throws(
          () => buildRewrite(root, raw),
          /explicit empty subtrees|unsupported tree path/,
        );
        const cli = NodeChildProcess.spawnSync(
          process.execPath,
          [
            NodePath.join(import.meta.dirname, "fork-sync.ts"),
            "rewrite-build",
            "--manifest",
            manifestPath,
            "--json",
          ],
          { cwd: root, encoding: "utf8" },
        );
        assert.strictEqual(cli.status, 3, cli.stdout);
        assert.isFalse(yield* fs.exists(`${manifestPath}.receipt.json`));
        yield* fs.writeFileString(`${manifestPath}.receipt.json`, "{}");
        assert.throws(
          () => verifyRewriteBuild(root, manifestPath, `${manifestPath}.receipt.json`),
          /explicit empty subtrees|unsupported tree path/,
        );
        assert.strictEqual(git(root, ["count-objects", "-v"]), before);
      }
    }),
  );

  it.effect("verifier rejects relocated or nonregular artifacts before Git traversal", () =>
    Effect.gen(function* () {
      const { root, directory, fs, manifest } = yield* fixture();
      const raw = Buffer.from(encodeJson(manifest));
      const receipt = buildRewrite(root, raw);
      const manifestPath = NodePath.join(directory, "manifest.json");
      const receiptPath = `${manifestPath}.receipt.json`;
      yield* fs.writeFile(manifestPath, raw);
      yield* fs.writeFileString(receiptPath, encodeJson(receipt));
      assert.deepStrictEqual(
        verifyRewriteBuild(
          root,
          NodePath.relative(root, manifestPath),
          NodePath.relative(root, receiptPath),
        ),
        receipt,
      );
      const inside = NodePath.join(root, ".git/inside.json");
      yield* fs.writeFile(inside, raw);
      yield* fs.writeFileString(`${inside}.receipt.json`, encodeJson(receipt));
      const redirected = NodePath.join(directory, "redirected");
      yield* fs.symlink(NodePath.join(root, ".git"), redirected);
      const linked = NodePath.join(directory, "linked.json");
      yield* fs.symlink(manifestPath, linked);
      const dangling = NodePath.join(directory, "dangling.json");
      yield* fs.symlink(NodePath.join(directory, "missing-target"), dangling);
      const nonregular = NodePath.join(directory, "directory.json");
      yield* fs.makeDirectory(nonregular);
      // A missed artifact refusal would reach the constructor's Git/config probe instead.
      git(root, ["config", "remote.review.promisor", "true"]);
      const before = git(root, ["count-objects", "-v"]);
      for (const invalid of [
        inside,
        NodePath.join(redirected, "inside.json"),
        linked,
        dangling,
        nonregular,
        NodePath.join(directory, "missing.json"),
      ]) {
        assert.throws(
          () => verifyRewriteBuild(root, invalid, receiptPath),
          /outside the repository|regular external files/,
        );
        assert.throws(
          () => verifyRewriteBuild(root, manifestPath, invalid),
          /outside the repository|regular external files/,
        );
      }
      assert.strictEqual(git(root, ["count-objects", "-v"]), before);
    }),
  );

  it.effect("refuses stale or incomplete snapshots and nonconvergent final trees", () =>
    Effect.gen(function* () {
      const { root, manifest } = yield* fixture();
      const check = (value: unknown) => buildRewrite(root, Buffer.from(encodeJson(value)));
      assert.throws(() => check({ ...manifest, source: manifest.base }), /stale rewrite source/);
      assert.throws(
        () => check({ ...manifest, slots: manifest.slots.slice(1) }),
        /every original commit/,
      );
      assert.throws(
        () => check({ ...manifest, unresolved: ["preview closure"] }),
        /unresolved rewrite proof/,
      );
      assert.throws(() => check({ ...manifest, proofs: [] }), /reviewed snapshot-tests/);
      assert.throws(
        () =>
          check({ ...manifest, slots: [{ ...manifest.slots[0], readSet: [] }, manifest.slots[1]] }),
        /missing from read set/,
      );
      assert.throws(
        () =>
          check({
            ...manifest,
            slots: [
              { ...manifest.slots[0], resultTree: manifest.slots[0]!.tree },
              manifest.slots[1],
            ],
          }),
        /output digest/,
      );
      assert.throws(
        () =>
          check({
            ...manifest,
            slots: [
              manifest.slots[0],
              {
                ...manifest.slots[1],
                changes: manifest.slots[0]!.changes.map((row) => ({
                  ...row,
                  before: row.after,
                  after: row.before,
                })),
                readSet: manifest.slots[0]!.changes.map((row) => ({
                  path: row.path,
                  entry: row.after,
                })),
                resultTree: manifest.slots[0]!.tree,
              },
            ],
          }),
        /final full tree/,
      );
      assert.throws(
        () =>
          parseRewriteManifest({
            schema: "t3code.historical-repair-transform-design.v1",
            executionAllowed: false,
          }),
        /unknown rewrite manifest field|design inputs/,
      );
      assert.throws(
        () =>
          check({
            ...manifest,
            slots: [
              {
                ...manifest.slots[0],
                changes: [...manifest.slots[0]!.changes, manifest.slots[0]!.changes[0]],
              },
              manifest.slots[1],
            ],
          }),
        /duplicate snapshot path/,
      );
    }),
  );

  it.effect("actual CLI has strict usage, complete JSON and repeatable receipts", () =>
    Effect.gen(function* () {
      const { root, directory, fs, manifest } = yield* fixture();
      const path = NodePath.join(directory, "manifest.json");
      yield* fs.writeFileString(path, encodeJson(manifest));
      const invokeFrom = (cwd: string, ...args: string[]) =>
        NodeChildProcess.spawnSync(
          process.execPath,
          [NodePath.join(import.meta.dirname, "fork-sync.ts"), "rewrite-build", ...args],
          { cwd, encoding: "utf8" },
        );
      const invoke = (...args: string[]) => invokeFrom(root, ...args);
      const refs = git(root, ["show-ref"]);
      const help = invoke("--help");
      assert.strictEqual(help.status, 0);
      assert.include(help.stdout, "rewrite-build --manifest");
      const invalid = invoke("--manifest", path, "--json", "--unknown");
      assert.strictEqual(invalid.status, 2);
      assert.strictEqual(decodeCliError(invalid.stdout).exitCode, 2);
      assert.isFalse(yield* fs.exists(`${path}.receipt.json`));
      const inside = NodePath.join(root, "inside.json");
      yield* fs.writeFileString(inside, encodeJson(manifest));
      const subdirectory = NodePath.join(root, "ordered");
      const before = git(root, ["count-objects", "-v"]);
      for (const cwd of [root, subdirectory]) {
        const rejected = invokeFrom(cwd, "--manifest", "inside.json", "--json");
        assert.strictEqual(rejected.status, 3, rejected.stdout);
        assert.include(rejected.stdout, "outside the repository");
      }
      const redirected = NodePath.join(directory, "redirected");
      yield* fs.symlink(root, redirected);
      const symlinked = invoke("--manifest", NodePath.join(redirected, "inside.json"), "--json");
      assert.strictEqual(symlinked.status, 3, symlinked.stdout);
      assert.isFalse(yield* fs.exists(`${inside}.receipt.json`));
      const blocked = NodePath.join(directory, "blocked.json");
      yield* fs.writeFileString(blocked, encodeJson(manifest));
      yield* fs.symlink(NodePath.join(root, "missing-receipt"), `${blocked}.receipt.json`);
      const dangling = invoke("--manifest", blocked, "--json");
      assert.strictEqual(dangling.status, 3, dangling.stdout);
      assert.isFalse(yield* fs.exists(NodePath.join(root, "missing-receipt")));
      assert.strictEqual(git(root, ["count-objects", "-v"]), before);
      const first = invoke("--manifest", path, "--json");
      assert.strictEqual(first.status, 0, first.stderr);
      const receipt = decodeCliResult(first.stdout);
      assert.match(receipt.result, /^[a-f0-9]{40}$/);
      assert.strictEqual(receipt.receiptPath, `${path}.receipt.json`);
      assert.strictEqual(invoke("--manifest", path, "--json").stdout, first.stdout);
      assert.strictEqual(
        invokeFrom(subdirectory, "--manifest", NodePath.relative(root, path), "--json").stdout,
        first.stdout,
      );
      assert.strictEqual(git(root, ["show-ref"]), refs);
    }),
  );
});
