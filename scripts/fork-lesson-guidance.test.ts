// @effect-diagnostics nodeBuiltinImport:off - Verify immutable lesson reads against isolated Git history.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  ORIGINAL_LESSON_PATHS,
  lessonInventory,
  readLessonEvidence,
  resolveLessonSource,
  renderLessonGuidance,
  preferredLessonBoundary,
} from "./fork-lesson-guidance.ts";
import {
  CHURN_REF,
  CHURN_LEDGER_FILE,
  fetchBotRef,
  resolveBotRef,
  writeBotRefFile,
} from "./lib/fork-bot-refs.ts";
import { freezeObservation, seamRecord } from "./lib/fork-churn-seams.ts";
import type { CommandResult } from "./lib/fork-command.ts";

const A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40);
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeSync = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const empty = '{"version":2,"walks":[],"seamRecords":[]}';
const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });

it("routes retained hot paths to their reviewed issue scope and implementation boundary", () => {
  const cases = [
    ["pnpm-lock.yaml", 312, "pinned lockfile generator"],
    [".github/workflows/hyprws-release.yml", 573, "fork-workflow-reviews.json"],
    ["apps/web/src/state/terminalSessions.ts", 582, "terminalAttachmentRetention.fork.ts"],
    ["apps/server/src/git/GitManager.test.ts", 448, "new fork-specific test cases only"],
    ["apps/desktop/src/preview/Manager.ts", 524, "WindowPolicy.ts"],
    ["apps/desktop/src/ipc/methods/preview.ts", 524, "WindowPolicy.ts"],
    ["apps/desktop/src/preload.ts", 524, "WindowPolicy.preload.ts"],
    ["apps/web/src/routes/_chat.pull-requests.tsx", 535, "PullRequestProjectScope.ts"],
    [
      "apps/web/src/components/pullRequest/PullRequestListFilters.tsx",
      535,
      "PullRequestProjectScope.ts",
    ],
    ["apps/web/src/components/Sidebar.tsx", 584, "SidebarPhysicalScope.ts"],
    ["apps/web/src/components/LegacySidebar.tsx", 584, "SidebarPhysicalScope.ts"],
    ["apps/web/src/components/AppSidebarLayout.tsx", 584, "physical project scope only"],
    [
      "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
      536,
      "ignoredWorkspaceFileListing.ts",
    ],
    [
      "apps/mobile/src/features/files/thread-file-navigator-pane.tsx",
      536,
      "ignoredWorkspaceFileListing.ts",
    ],
    ["apps/web/src/components/files/FilePreviewPanel.tsx", 538, "RichMarkdownPreviewBoundary.tsx"],
    ["apps/web/src/markdown-links.ts", 538, "richMarkdownEditorLinks.ts"],
    ["apps/web/src/components/chat/MessagesTimeline.tsx", 537, "AgentSpawnNavigation.ts"],
    ["apps/web/src/components/settings/settingsSearch.ts", 539, "githubIssueSettingsSearch.ts"],
    ["apps/web/src/components/ChatView.tsx", 446, "thread-route navigation only"],
    [
      "apps/server/src/provider/Layers/ClaudeProvider.ts",
      583,
      "Claude SDK agent normalization and model selection metadata only",
    ],
    [
      "apps/server/src/provider/Drivers/CodexDriver.ts",
      583,
      "Codex discovered-agent model selection metadata only",
    ],
  ] as const;
  for (const [path, owner, boundary] of cases) {
    const mapped = preferredLessonBoundary(path);
    assert.strictEqual(mapped?.owner, owner, path);
    assert.include(mapped?.boundary ?? "", boundary, path);
  }
});

it("does not infer a reviewed boundary from a basename or unrelated provider behavior", () => {
  for (const path of [
    "apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts",
    "apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts",
    "apps/mobile/src/components/FilePreview.tsx",
    "apps/mobile/src/features/files/UnreviewedRoute.tsx",
    "apps/server/src/provider/Layers/OtherSessionRuntime.ts",
    "apps/server/src/provider/Layers/CodexSessionRuntime.ts",
    "apps/server/src/provider/Drivers/ClaudeDriver.ts",
    "apps/server/src/provider/Layers/CodexProvider.ts",
    "apps/server/src/provider/Layers/CodexAdapter.ts",
    "apps/server/src/provider/Layers/ProviderService.ts",
    ".github/workflows/hyprws-upstream-sync.yml",
  ])
    assert.strictEqual(preferredLessonBoundary(path), undefined, path);
  for (const path of [
    "apps/server/src/provider/Layers/ClaudeProvider.ts",
    "apps/server/src/provider/Drivers/CodexDriver.ts",
  ])
    assert.include(
      preferredLessonBoundary(path)?.boundary ?? "",
      "startup/resume, child-work results, identity and launcher environment joins require their own scoped review",
    );
});

it("rejects immutable SHAs and unqualified names before any ref resolution or fetch", () => {
  for (const ref of [
    A,
    "hyprws",
    "refs/heads/hyprws",
    "refs/fork/../heads/accidental",
    "refs/fork/churn:refs/heads/accidental",
  ]) {
    let calls = 0;
    assert.throws(
      () =>
        resolveLessonSource("/not-a-repository", ref, false, () => {
          calls += 1;
          return ok();
        }),
      /named refs\/fork/,
    );
    assert.strictEqual(calls, 0);
    assert.throws(() => fetchBotRef("/not-a-repository", ref), /named refs\/fork/);
    assert.throws(() => resolveBotRef("/not-a-repository", ref), /named refs\/fork/);
  }
});

it("makes offline reads explicit without a fetch or remote subprocess", () => {
  const calls: ReadonlyArray<string>[] = [];
  const result = resolveLessonSource("/fixture", CHURN_REF, true, (args) => {
    calls.push(args);
    return ok(args[0] === "rev-parse" ? A : empty);
  });
  assert.strictEqual(result.freshness, "offline");
  assert.strictEqual(result.sha, A);
  assert.deepStrictEqual(
    calls.map((args) => args[0]),
    ["rev-parse", "show"],
  );
});

it("reports stale evidence when published objects cannot be fetched", () => {
  const result = resolveLessonSource("/fixture", CHURN_REF, false, (args) => {
    if (args[0] === "rev-parse") return ok(A);
    if (args[0] === "ls-remote") return ok(`${B}\t${CHURN_REF}\n`);
    if (args[0] === "show" && args[1] === `${A}:${CHURN_LEDGER_FILE}`) return ok(empty);
    return { status: 1, stdout: "", stderr: "offline fixture" };
  });
  assert.strictEqual(result.freshness, "stale");
  assert.strictEqual(result.sha, A);
  assert.strictEqual(result.remoteSha, B);
});

it("distinguishes an absent published ref from an unreachable origin", () => {
  for (const status of [2, 128]) {
    const result = resolveLessonSource("/fixture", CHURN_REF, false, (args) => {
      if (args[0] === "rev-parse") return ok(A);
      if (args[0] === "show") return ok(empty);
      assert.strictEqual(args[0], "ls-remote");
      return { status, stdout: "", stderr: "fixture unavailable" };
    });
    assert.strictEqual(result.freshness, status === 2 ? "unavailable" : "offline");
    assert.strictEqual(result.sha, A);
    assert.strictEqual(result.raw, empty);
    assert.strictEqual(result.remoteSha, null);
  }
});

it("does not assert current evidence if origin moves during the immutable read", () => {
  let advertisements = 0;
  const result = resolveLessonSource("/fixture", CHURN_REF, false, (args) => {
    if (args[0] === "rev-parse") return ok(A);
    if (args[0] === "ls-remote") return ok(`${++advertisements === 1 ? B : C}\t${CHURN_REF}\n`);
    return ok(empty);
  });
  assert.strictEqual(result.sha, B);
  assert.strictEqual(result.remoteSha, C);
  assert.strictEqual(result.freshness, "stale");
  assert.include(result.detail, "moved");
});

it("retains original and unmapped lessons across legacy, v2 and v3 projections", () => {
  const unknownPath = "apps/server/src/newUpstreamSeam.ts";
  const record = seamRecord(
    freezeObservation({
      tag: "v1",
      fixedAt: null,
      files: [
        {
          path: unknownPath,
          commit: A,
          domain: "fork-meta",
          hunks: null,
          subject: "new retained lesson",
        },
      ],
    }),
  );
  const raw = `{"version":3,"walks":[],"seamRecords":[${encodeSync(record)}],"outcomes":[{"preserved":"owned by outcome accounting"}]}`;
  const current = lessonInventory(readLessonEvidence(raw));
  assert.strictEqual(current.filter((row) => row.original).length, ORIGINAL_LESSON_PATHS.length);
  assert.strictEqual(current.find((row) => row.path === unknownPath)?.observations, 1);
  assert.strictEqual(current.find((row) => row.path === unknownPath)?.preferred, undefined);
  assert.strictEqual(
    lessonInventory(readLessonEvidence("[]")).length,
    ORIGINAL_LESSON_PATHS.length,
  );
  assert.deepStrictEqual(readLessonEvidence(empty), { walks: [], seamRecords: [] });
  const output = renderLessonGuidance(
    { ref: CHURN_REF, sha: A, remoteSha: null, freshness: "offline", detail: "fixture", raw },
    readLessonEvidence(raw),
  );
  assert.include(output, `${unknownPath} [1 retained observation(s)] -> unresolved`);
  assert.include(output, "do not prove repair");
});

it.layer(NodeServices.layer)("live lesson authoring CLI", (it) => {
  it.effect(
    "a newly published lesson reaches an existing checkout and names its preferred boundary without moving refs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-lesson-cli-" });
        const publisher = NodePath.join(root, "publisher"),
          consumer = NodePath.join(root, "consumer"),
          remote = NodePath.join(root, "origin.git");
        for (const path of [publisher, consumer]) yield* fs.makeDirectory(path);
        const git = (cwd: string, args: ReadonlyArray<string>) =>
          NodeChildProcess.execFileSync("git", [...args], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        git(root, ["init", "--bare", remote]);
        for (const path of [publisher, consumer]) {
          git(path, ["init", "--initial-branch=fixture"]);
          git(path, ["config", "user.name", "Fixture"]);
          git(path, ["config", "user.email", "fixture@example.invalid"]);
          git(path, ["remote", "add", "origin", remote]);
        }
        const first = writeBotRefFile(
          publisher,
          CHURN_REF,
          CHURN_LEDGER_FILE,
          empty,
          "initial lessons",
        );
        git(publisher, ["push", "origin", `${CHURN_REF}:${CHURN_REF}`]);
        git(consumer, ["fetch", "origin", `${CHURN_REF}:${CHURN_REF}`]);
        const write = Effect.fn("writeLessonFixture")(function* (path: string, content: string) {
          const absolute = NodePath.join(consumer, path);
          yield* fs.makeDirectory(NodePath.dirname(absolute), { recursive: true });
          yield* fs.writeFileString(absolute, content);
        });
        const source = "apps/web/src/state/terminalSessions.ts";
        yield* write(source, "export const upstreamMetadata = 1;\n");
        yield* write(
          "docs/internals/fork-delta.md",
          "## fork-meta\n\n### Rebase scan\n\n| Path | Why |\n| --- | --- |\n",
        );
        const pairs = ["ci", "release"].map((name) => ({
          upstream: `.github/workflows/${name}.yml`,
          fork: `.github/workflows/hyprws-${name}.yml`,
        }));
        for (const pair of pairs) {
          yield* write(pair.upstream, "jobs: {}\n");
          yield* write(pair.fork, "jobs: {}\n");
        }
        git(consumer, ["add", "."]);
        git(consumer, ["commit", "-m", "upstream fixture"]);
        const base = git(consumer, ["rev-parse", "HEAD"]);
        yield* write(
          ".github/fork-workflow-reviews.json",
          yield* encode({
            version: 1,
            reviews: pairs.map((pair) => ({
              ...pair,
              upstreamCommit: base,
              upstreamBlob: git(consumer, ["rev-parse", `${base}:${pair.upstream}`]),
              forkBlob: git(consumer, ["rev-parse", `${base}:${pair.fork}`]),
              disposition: "no-change",
              reason: "fixture counterpart review",
            })),
          }),
        );
        yield* write(
          source,
          "export const upstreamMetadata = 1;\nexport const narrowForkJoin = 2;\n",
        );
        git(consumer, ["add", "."]);
        git(consumer, ["commit", "-m", "fixture author\n\nFork-Domain: fork-meta\nFork-Tier: qol"]);
        const scan = (...extra: string[]) =>
          NodeChildProcess.spawnSync(
            process.execPath,
            [
              NodePath.join(import.meta.dirname, "fork-scan.ts"),
              "--target",
              base,
              "--since",
              base,
              "--no-typecheck",
              ...extra,
            ],
            { cwd: consumer, encoding: "utf8" },
          );
        const initial = scan();
        assert.strictEqual(initial.status, 0, initial.stderr);
        assert.include(initial.stdout, `at ${first}; freshness=current`);
        assert.notInclude(initial.stdout, "terminalAttachmentRetention.fork.ts");
        const observation = seamRecord(
          freezeObservation({
            tag: "v2",
            fixedAt: null,
            files: [
              {
                path: source,
                hunks: null,
                commit: base,
                domain: "fork-meta",
                subject: "new terminal seam",
              },
            ],
          }),
        );
        const next = writeBotRefFile(
          publisher,
          CHURN_REF,
          CHURN_LEDGER_FILE,
          yield* encode({ version: 3, walks: [], seamRecords: [observation], outcomes: [] }),
          "new lesson",
        );
        git(publisher, ["push", "origin", `${CHURN_REF}:${CHURN_REF}`]);
        const fetchHeadPath = NodePath.join(consumer, ".git/FETCH_HEAD");
        const fetchHeadBefore = (yield* fs.exists(fetchHeadPath))
          ? yield* fs.readFileString(fetchHeadPath)
          : null;
        const fresh = scan();
        assert.strictEqual(fresh.status, 0, fresh.stderr);
        assert.include(fresh.stdout, `at ${next}; freshness=current`);
        assert.include(fresh.stdout, "terminalAttachmentRetention.fork.ts");
        assert.include(fresh.stdout, "advisory");
        assert.strictEqual(git(consumer, ["rev-parse", CHURN_REF]), first);
        assert.strictEqual(
          (yield* fs.exists(fetchHeadPath)) ? yield* fs.readFileString(fetchHeadPath) : null,
          fetchHeadBefore,
        );
        assert.strictEqual(
          git(consumer, ["for-each-ref", "--format=%(refname)", "refs/heads"]),
          "refs/heads/fixture",
        );
        const offline = scan("--offline");
        assert.strictEqual(offline.status, 0, offline.stderr);
        assert.include(offline.stdout, `at ${first}; freshness=offline`);
        assert.notInclude(offline.stdout, "terminalAttachmentRetention.fork.ts");
        const frozen = yield* fs.readFileString(
          NodePath.join(import.meta.dirname, "../docs/internals/fork-churn.md"),
        );
        const originalRows = frozen
          .split("## Per file\n")[1]!
          .split("## Per fork commit")[0]!
          .split("\n")
          .flatMap((line) => /^\| `([^`]+)`/.exec(line)?.[1] ?? []);
        assert.deepStrictEqual([...ORIGINAL_LESSON_PATHS].toSorted(), originalRows.toSorted());
      }),
  );
});
