import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type ThreadIssueKey,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { listLinkedIssueThreadsFork } from "../githubIssue/linkedThreads.fork.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import { OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import type { ThreadIssueCommandFork } from "./ThreadIssues.fork.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-thread-issues-",
});
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(ServerConfigLayer),
      Layer.provide(PlatformTestLayer),
    ),
  ),
);
// Issue commands never open a provider session, so no instance is registered.
const EmptyProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: () => Effect.succeed(undefined),
    listInstances: Effect.succeed([]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const TestLayer = OrchestrationV2LayerLive.pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(EmptyProviderInstanceRegistry),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.none()),
    }),
  ),
  Layer.provide(PlatformTestLayer),
);

const start = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z");
const at = (seconds: number) => DateTime.formatIso(DateTime.add(start, { seconds }));

const projectId = ProjectId.make("project-issues");
const threadA = ThreadId.make("thread-issues-a");
const threadB = ThreadId.make("thread-issues-b");
const issue: ThreadIssueKey = { host: "github.com", repository: "acme/web", number: 7 };
const issueUrl = "https://github.com/acme/web/issues/7";

let commandCounter = 0;
const commandId = () => CommandId.make(`cmd-issues-${(commandCounter += 1)}`);

const createThread = (threadId: ThreadId): OrchestrationV2ServerCommand => ({
  type: "thread.create",
  createdBy: "user",
  creationSource: "web",
  commandId: commandId(),
  threadId,
  projectId,
  title: threadId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
});

const link = (
  threadId: ThreadId,
  key: ThreadIssueKey = issue,
  source: "manual" | "handoff" | "agent" = "manual",
): ThreadIssueCommandFork => ({
  type: "thread.issue.link",
  commandId: commandId(),
  threadId,
  ...key,
  url: issueUrl,
  source,
});

const unlink = (threadId: ThreadId): ThreadIssueCommandFork => ({
  type: "thread.issue.unlink",
  commandId: commandId(),
  threadId,
  ...issue,
});

const sync = (threadId: ThreadId, syncedAt: string): ThreadIssueCommandFork => ({
  type: "thread.issue-link.sync",
  commandId: commandId(),
  threadId,
  ...issue,
  snapshot: { title: "Fix the thing", state: "open", syncedAt },
});

it.layer(TestLayer)("thread issue links on Orchestrator V2", (it) => {
  it.effect("link, sync, unlink, re-link and delete agree across every read and a rebuild", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(start));
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const thread = (threadId: ThreadId) =>
        orchestrator.getThreadProjection(threadId).pipe(Effect.map((p) => p.thread));
      const issuesOf = (threadId: ThreadId) =>
        thread(threadId).pipe(Effect.map((current) => current.issues));
      const shellIssues = (threadId: ThreadId) =>
        orchestrator.getThreadShell(threadId).pipe(Effect.map((shell) => shell?.issues));
      // A refusal writes nothing: the thread's event sequence stays put.
      const refused = (command: ThreadIssueCommandFork) =>
        Effect.gen(function* () {
          const before = yield* orchestrator.getThreadEventSequence(command.threadId);
          const error = yield* orchestrator.dispatch(command).pipe(Effect.flip);
          assert.strictEqual(error._tag, "OrchestratorDispatchError");
          assert.strictEqual(yield* orchestrator.getThreadEventSequence(command.threadId), before);
        });
      const linkedIds = listLinkedIssueThreadsFork(issue).pipe(
        Effect.map((result) => result.threads.map((linked) => linked.id)),
      );

      yield* orchestrator.dispatch(createThread(threadA));
      yield* orchestrator.dispatch(createThread(threadB));
      assert.isFalse("issues" in (yield* thread(threadA)));

      // Linking stores the normalized key, with no state until the first sync.
      yield* TestClock.adjust("10 seconds");
      yield* orchestrator.dispatch(
        link(threadA, { host: "GitHub.com", repository: "Acme/Web", number: 7 }),
      );
      yield* orchestrator.dispatch(link(threadB, issue, "handoff"));
      const linked = [
        { ...issue, url: issueUrl, source: "manual" as const, linkedAt: at(10), snapshot: null },
      ];
      assert.deepStrictEqual(yield* issuesOf(threadA), linked);
      assert.deepStrictEqual(yield* shellIssues(threadA), linked);
      assert.strictEqual(DateTime.formatIso((yield* thread(threadA)).updatedAt), at(10));

      // Linking twice changes nothing, however the key is cased.
      yield* refused(link(threadA, { ...issue, repository: "ACME/WEB" }));

      // A snapshot read before the link was made describes an earlier link.
      yield* refused(sync(threadA, at(5)));
      yield* TestClock.adjust("10 seconds");
      yield* orchestrator.dispatch(sync(threadA, at(20)));
      const snapshot = { title: "Fix the thing", state: "open" as const, syncedAt: at(20) };
      assert.deepStrictEqual((yield* issuesOf(threadA))?.[0]?.snapshot, snapshot);
      // A host read is not thread activity.
      assert.strictEqual(DateTime.formatIso((yield* thread(threadA)).updatedAt), at(10));
      // A read that finishes after a newer one never overwrites it.
      yield* refused(sync(threadA, at(15)));
      assert.deepStrictEqual((yield* shellIssues(threadA))?.[0]?.snapshot, snapshot);

      // Unlink is a real removal; a second unlink and a sync for it are refused.
      yield* orchestrator.dispatch(unlink(threadA));
      assert.isFalse("issues" in (yield* thread(threadA)));
      assert.isUndefined(yield* shellIssues(threadA));
      yield* refused(unlink(threadA));
      yield* refused(sync(threadA, at(20)));

      // Re-linking after an unlink starts a fresh link.
      yield* TestClock.adjust("10 seconds");
      yield* orchestrator.dispatch(link(threadA, issue, "agent"));
      const relinked = [
        { ...issue, url: issueUrl, source: "agent" as const, linkedAt: at(30), snapshot: null },
      ];
      assert.deepStrictEqual(yield* issuesOf(threadA), relinked);
      assert.deepStrictEqual(yield* linkedIds, [threadA, threadB]);

      // A deleted thread leaves the reverse lookup and takes no new links.
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: commandId(),
        threadId: threadB,
      });
      yield* refused(unlink(threadB));
      yield* refused(link(threadB, { ...issue, number: 8 }));
      assert.deepStrictEqual(yield* linkedIds, [threadA]);

      // Every change rides upstream event types, so a client from before issue links
      // meets no event it cannot decode on the thread or shell streams.
      const sql = yield* SqlClient.SqlClient;
      const forkEvents = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events WHERE event_type LIKE 'thread.issue%'
      `;
      assert.strictEqual(forkEvents[0]?.count, 0);

      // A projection rebuilt from the event log serves the same links.
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepStrictEqual(yield* issuesOf(threadA), relinked);
      assert.deepStrictEqual(yield* shellIssues(threadA), relinked);

      // An archived thread keeps its links and stays in the reverse lookup.
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: commandId(),
        threadId: threadA,
      });
      const archived = yield* listLinkedIssueThreadsFork(issue);
      assert.deepStrictEqual(
        archived.threads.map((entry) => [entry.id, entry.archivedAt !== null]),
        [[threadA, true]],
      );
      assert.deepStrictEqual(yield* shellIssues(threadA), relinked);
    }),
  );
});
