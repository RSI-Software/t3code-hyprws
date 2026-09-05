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
  lessonHotSeams,
  lessonObservations,
} from "./fork-lesson-guidance.ts";
import type { ChurnEntry, CensusSnapshot } from "./fork-churn-ledger.ts";
import {
  ADOPTED_AUTHORING_GUARDS,
  AUTHORING_GUARD_TARGETS,
  UPSTREAM_TEST_FILE_LOCAL_HARNESS_DEFERRALS,
} from "./fork-scan-guards.ts";
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
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const empty = '{"version":2,"walks":[],"seamRecords":[]}';
const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });

it("covers every adopted named guard's real source targets with scoped lesson guidance", () => {
  assert.deepStrictEqual(
    Object.keys(AUTHORING_GUARD_TARGETS).toSorted(),
    [...ADOPTED_AUTHORING_GUARDS].filter((rule) => rule !== "upstream-test").toSorted(),
  );
  const policyReferences = {
    "terminal-attachment-boundary": 582,
    "provider-agent-boundary": 583,
    "sidebar-physical-scope": 584,
    "thread-route-navigation": 446,
    "pull-request-project-scope": 535,
    "github-issue-settings-search": 539,
    "mobile-ignored-file-listing": 536,
    "agent-spawn-navigation": 537,
    "rich-markdown-boundary": 538,
  };
  for (const [rule, targets] of Object.entries(AUTHORING_GUARD_TARGETS)) {
    assert.isAbove(Object.keys(targets).length, 0, rule);
    for (const path of Object.values(targets)) {
      const preferred = preferredLessonBoundary(path);
      assert.isDefined(preferred, `${rule}: ${path}`);
      assert.strictEqual(
        preferred?.owner,
        policyReferences[rule as keyof typeof policyReferences],
        `${rule}: ${path}`,
      );
    }
  }
  assert.include(
    preferredLessonBoundary(AUTHORING_GUARD_TARGETS["pull-request-project-scope"].retiredParser)
      ?.boundary ?? "",
    "do not recreate this route parser",
  );
  assert.include(
    preferredLessonBoundary(AUTHORING_GUARD_TARGETS["provider-agent-boundary"].codex)?.boundary ??
      "",
    "runtime and child-work policy remains unresolved",
  );
  assert.isTrue(ADOPTED_AUTHORING_GUARDS.has("upstream-test"));
  for (const path of UPSTREAM_TEST_FILE_LOCAL_HARNESS_DEFERRALS)
    assert.include(
      preferredLessonBoundary(path)?.boundary ?? "",
      "exact file-local harness deferral",
    );
});

it("deduplicates frozen copies of legacy censuses without creating single-occurrence hot warnings", () => {
  const file = {
    path: "apps/web/src/state/shell.ts",
    subject: "bootstrap physical window",
    commit: A,
    domain: "project-windows",
    hunks: null,
  };
  const snapshot: CensusSnapshot = { tag: "v1", fixedAt: B, files: [file] };
  const walk: ChurnEntry = {
    tag: "v1",
    before: A,
    after: B,
    recordUrl: "https://example.test/walk",
    conflicts: [],
    decisions: [],
    censusFiles: [file],
  };
  const record = seamRecord(freezeObservation(snapshot));
  const evidence = { walks: [walk], seamRecords: [record] };
  assert.strictEqual(lessonObservations(evidence).size, 1);
  assert.strictEqual(
    lessonInventory(evidence).find((row) => row.path === file.path)?.observations,
    1,
  );
  assert.isFalse(lessonHotSeams(evidence).has(file.path));
  const next = seamRecord(freezeObservation({ ...snapshot, tag: "v2" }));
  assert.strictEqual(
    lessonHotSeams({ ...evidence, seamRecords: [record, next] }).get(file.path)?.walkCount,
    2,
  );
});

it("renders assessed repair states instead of presenting a guard name as verification", () => {
  const file = {
    path: "apps/web/src/state/shell.ts",
    subject: "bootstrap physical window",
    commit: A,
    domain: "project-windows",
    hunks: null,
  };
  const observation = (sourceSha: string, present: boolean) =>
    seamRecord(
      freezeObservation({
        tag: "v1",
        fixedAt: null,
        files: present ? [file] : [],
        censusEvidence: {
          version: 1,
          method: "sequential-rebase-stage3-provisional",
          sourceSha,
          baseSha: "d".repeat(40),
          targetSha: C,
          targetTag: "v1",
          complete: true,
          rows: present
            ? [
                {
                  stop: 1,
                  path: file.path,
                  commit: file.commit,
                  subject: file.subject,
                  domain: file.domain,
                  kind: "content",
                },
              ]
            : [],
        },
      }),
    );
  const before = observation(A, true),
    clear = observation(B, false),
    returned = observation(C, true);
  const attestation = { actor: "maintainer", evidenceUrl: "https://example.test/review" };
  const repair = seamRecord({
    kind: "repair",
    before: { observation: before.id, row: 0 },
    changeSha: B,
    guard: "physical-bootstrap",
    attestation,
  } as const);
  const verified = seamRecord({
    kind: "verification",
    repair: repair.id,
    after: clear.id,
    guardProof: {
      sourceSha: B,
      command: "vp test run bootstrap.fork.test.ts",
      exitCode: 0,
      output: "1 passed",
    },
    attestation,
  } as const);
  for (const [records, status, completed] of [
    [[before, repair], "repair-unverified"],
    [[before, clear], "not-observed"],
    [[before, clear, repair, verified], "verified-repaired"],
    [[before, clear, repair, verified, returned], "regressed"],
    [[before, clear, repair, verified], "verified-repaired", clear],
    [[before, clear, repair, verified], "regressed", returned],
  ] as const) {
    const evidence = readLessonEvidence(
      encodeSync({
        version: 3,
        seamRecords: records,
        outcomes: [],
        walks:
          completed === undefined
            ? []
            : [
                {
                  tag: completed.tag,
                  before: A,
                  after: completed.evidence!.sourceSha,
                  recordUrl: "https://example.test/completed-walk",
                  conflicts: [],
                  decisions: [],
                  censusFiles: completed.files,
                  censusEvidence: completed.evidence,
                },
              ],
      }),
    );
    const output = renderLessonGuidance(
      { ref: CHURN_REF, sha: A, remoteSha: A, freshness: "current", detail: "fixture", raw: null },
      evidence,
    );
    assert.include(output, `evidence: ${status}`);
    assert.notInclude(output, "(owner ");
    assert.include(output, "policy reference #535; issue status is not inferred");
    if (completed !== undefined) {
      const assessment = lessonInventory(evidence).find((row) => row.path === file.path)
        ?.assessments[0];
      assert.strictEqual(assessment?.status, status);
      assert.strictEqual(assessment?.blocking, completed.id === returned.id);
      assert.deepStrictEqual(
        [...lessonObservations(evidence).keys()],
        completed.id === returned.id ? [before.id, clear.id, returned.id] : [before.id, clear.id],
      );
    }
  }
});

it("projects future compatible fields explicitly without claiming complete schema or repair support", () => {
  const known = seamRecord(
    freezeObservation({
      tag: "future",
      fixedAt: null,
      files: [
        { path: "new-seam.ts", subject: "new seam", commit: A, domain: "fork-meta", hunks: null },
      ],
    }),
  );
  const projected = readLessonEvidence(
    encodeSync({ version: 4, walks: [], seamRecords: [known], futureField: true }),
  );
  assert.strictEqual(
    lessonInventory(projected).find((row) => row.path === "new-seam.ts")?.observations,
    1,
  );
  assert.include(projected.notices?.[0] ?? "", "newer than this reader");
  assert.strictEqual(
    lessonInventory(projected)[0]?.assessmentUnavailable,
    "newer schema is only partially understood",
  );
  const incompatible = readLessonEvidence(
    encodeSync({ version: 4, walks: { changed: true }, seamRecords: [{ kind: "new-evidence" }] }),
  );
  assert.strictEqual(lessonInventory(incompatible).length, ORIGINAL_LESSON_PATHS.length);
  assert.lengthOf(incompatible.notices ?? [], 3);
});

it("keeps exact test deferrals and fork-owned tests out of generic sibling advice", () => {
  for (const path of [
    "apps/desktop/src/window/DesktopWindow.test.ts",
    "apps/server/src/server.test.ts",
  ])
    assert.include(
      preferredLessonBoundary(path)?.boundary ?? "",
      "exact file-local harness deferral",
    );
  assert.strictEqual(
    preferredLessonBoundary("apps/web/src/state/terminalSessions.test.ts")?.owner,
    582,
  );
  assert.strictEqual(
    preferredLessonBoundary("apps/web/src/state/terminalAttachmentRetention.fork.test.ts"),
    undefined,
  );
  assert.strictEqual(preferredLessonBoundary("apps/server/src/unreviewed.test.ts"), undefined);
});

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
        assert.include(fresh.stdout, "1 retained observation(s)");
        assert.strictEqual(git(consumer, ["rev-parse", CHURN_REF]), first);
        assert.strictEqual(
          (yield* fs.exists(fetchHeadPath)) ? yield* fs.readFileString(fetchHeadPath) : null,
          fetchHeadBefore,
        );
        assert.strictEqual(
          git(consumer, ["for-each-ref", "--format=%(refname)", "refs/heads"]),
          "refs/heads/fixture",
        );
        // The published review section must use the same current immutable source,
        // without refreshing the retained writer ref as a side effect.
        const reportBin = NodePath.join(root, "report-bin");
        const reportBodyPath = NodePath.join(root, "published-report.md");
        const reportReceiptPath = NodePath.join(root, "report-receipt.json");
        yield* fs.makeDirectory(reportBin);
        const fakeGh = NodePath.join(reportBin, "gh");
        yield* fs.writeFileString(
          fakeGh,
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "view") process.stdout.write(process.env.LESSON_ISSUE_FIXTURE);
else if (args[0] === "issue" && args[1] === "comment") {
  fs.writeFileSync(process.env.LESSON_PUBLISHED_FIXTURE, fs.readFileSync(args[args.indexOf("--body-file") + 1]));
  process.stdout.write("https://example.test/issues/1#issuecomment-1");
} else process.exitCode = 2;
`,
        );
        yield* fs.chmod(fakeGh, 0o755);
        const issueFixture = yield* encode({
          body: `## Sequential rebase census\n\nA throwaway rebase rehearsal to \`v2\` found one conflict.\n\n| File | Hunks | Fork commit | Domain |\n| --- | ---: | --- | --- |\n| \`${source}\` | 1 | \`${base.slice(0, 7)} new terminal seam\` | fork-meta |`,
          comments: [],
        });
        const publishReport = () =>
          NodeChildProcess.spawnSync(
            process.execPath,
            [
              NodePath.join(import.meta.dirname, "fork-churn.ts"),
              "report",
              "--issue",
              "1",
              "--receipt",
              reportReceiptPath,
            ],
            {
              cwd: consumer,
              encoding: "utf8",
              env: {
                ...process.env,
                PATH: `${reportBin}:${process.env.PATH ?? ""}`,
                LESSON_ISSUE_FIXTURE: issueFixture,
                LESSON_PUBLISHED_FIXTURE: reportBodyPath,
              },
            },
          );
        const report = publishReport();
        assert.strictEqual(report.status, 0, report.stderr);
        const published = yield* fs.readFileString(reportBodyPath);
        assert.include(published, `at ${next}; freshness=current`);
        assert.deepStrictEqual(decode(yield* fs.readFileString(reportReceiptPath)), {
          publication: "succeeded",
          policy: "succeeded",
          url: "https://example.test/issues/1#issuecomment-1",
        });
        assert.strictEqual(git(consumer, ["rev-parse", CHURN_REF]), first);
        const future = writeBotRefFile(
          publisher,
          CHURN_REF,
          CHURN_LEDGER_FILE,
          yield* encode({ version: 4, walks: [], seamRecords: [observation], futureField: true }),
          "future lesson schema",
        );
        git(publisher, ["push", "origin", `${CHURN_REF}:${CHURN_REF}`]);
        const futureReport = publishReport();
        assert.strictEqual(futureReport.status, 1);
        const unavailable = yield* fs.readFileString(reportBodyPath);
        assert.include(unavailable, `at ${future}; freshness=current`);
        assert.include(unavailable, "Lesson assessment unavailable");
        assert.include(futureReport.stderr, "does not establish a policy pass");
        assert.deepStrictEqual(decode(yield* fs.readFileString(reportReceiptPath)), {
          publication: "succeeded",
          policy: "failed",
          url: "https://example.test/issues/1#issuecomment-1",
        });
        assert.strictEqual(git(consumer, ["rev-parse", CHURN_REF]), first);
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
