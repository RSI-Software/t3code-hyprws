import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  EnvironmentId,
  NodeId,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

it.effect("reads round result transfers from the child without loading the parent's history", () =>
  Effect.gen(function* () {
    const parentId = ThreadId.make("thread:round-parent");
    const childId = ThreadId.make("thread:round-child");
    const taskId = NodeId.make("node:round-task");
    const now = DateTime.makeUnsafe("2026-11-10T00:00:00Z");
    const instanceId = ProviderInstanceId.make("codex");
    const task: OrchestrationV2Subagent = {
      id: taskId,
      threadId: parentId,
      runId: RunId.make("run:parent"),
      parentNodeId: NodeId.make("node:parent"),
      origin: "app_owned",
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId: childId,
      nativeTaskRef: null,
      prompt: "Review again",
      title: null,
      model: "gpt-5",
      status: "completed",
      result: "Second round done",
      completionDelivery: { state: "acknowledged", observedByRunId: null },
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const runs = [1, 2].map(
      (ordinal) =>
        ({
          id: RunId.make(`run:round-${ordinal}`),
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        }) as OrchestrationV2Run,
    );
    const transfers = runs.map(
      (run) =>
        ({
          id: ContextTransferId.make(`transfer:${run.ordinal}`),
          type: "subagent_result",
          sourceThreadId: childId,
          targetThreadId: parentId,
          sourcePoint: { runId: run.id },
        }) as OrchestrationV2ContextTransfer,
    );
    const parent = { ...idleThreadProjection(liveThreadShell(parentId)), subagents: [task] };
    const child = { ...idleThreadProjection(liveThreadShell(childId)), runs };
    let childTransfers = transfers;
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      ServerSettings.layerTest(),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId, fields, filter) => {
          if (threadId === parentId) {
            assert.equal(fields.join(","), "subagents");
            assert.deepEqual(filter?.subagentIds, [taskId]);
            return Effect.succeed(parent);
          }
          assert.equal(threadId, childId);
          return Effect.succeed({ ...child, contextTransfers: childTransfers });
        },
        delegatedTaskResultPending: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(RemoteDelegation.RemoteDelegation)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:rounds"),
        requestNamespace: "provider-session:rounds",
        thread: {
          threadId: parentId,
          providerSessionId: "provider-session:rounds",
          providerInstanceId: instanceId,
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      for (const [available, expected] of [
        [transfers, transfers[1]!.id],
        [transfers.slice(0, 1), transfers[0]!.id],
        [[], null],
      ] as const) {
        childTransfers = [...available];
        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, task.result);
        assert.equal(result.resultContextTransferId, expected);
      }
    }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
  }),
);
