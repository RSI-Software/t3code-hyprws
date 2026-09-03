// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CHILD_ITEM_RENDER_JSON_MAX_BYTES,
  ChildItemRenderDetail,
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderInstanceId,
  ProviderSession,
  RuntimeItemId,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  ProviderRuntimeIngestionLive,
  runtimeEventToActivities,
} from "./ProviderRuntimeIngestion.ts";
import { DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { projectAgentActivity } from "../AgentActivityProjection.ts";
import { makeChildItemRenderDetail } from "../../provider/childItemRenderDetail.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asItemId = (value: string): RuntimeItemId => RuntimeItemId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const encodeChildItemRenderDetailJson = Schema.encodeSync(
  Schema.fromJsonString(ChildItemRenderDetail),
);
const childItemRenderDetailBytes = (detail: ChildItemRenderDetail) =>
  new TextEncoder().encode(encodeChildItemRenderDetailJson(detail)).length;
describe("attributed item ingestion", () => {
  it("folds live and replayed Codex and Claude child work identically", () => {
    const makeClaudeEvent = (eventId: string): ProviderRuntimeEvent => ({
      type: "item.completed",
      eventId: asEventId(eventId),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      itemId: asItemId("assistant-child-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Agent message",
        detail: "child answer ".repeat(40),
        agentId: "task-child-1",
        timelineBypass: true,
        renderDetail: {
          result: "Claude child result",
          changedFiles: [{ path: "src/claude.ts", kind: "modified" }],
          truncated: false,
        },
        data: { result: "unbounded child result ".repeat(100) },
      },
    });
    const makeCodexEvent = (eventId: string): ProviderRuntimeEvent => ({
      type: "item.updated",
      eventId: asEventId(eventId),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      itemId: asItemId("codex-child-1"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Command",
        detail: "command output ".repeat(40),
        agentId: "codex-child-thread-1",
        timelineBypass: true,
        renderDetail: {
          command: "vp test run src/codex.test.ts",
          changedFiles: [{ path: "src/codex.ts", diff: "+hello" }],
          truncated: false,
        },
        data: { item: { aggregatedOutput: "unbounded child output ".repeat(100) } },
      },
    });
    const normalize = (event: ProviderRuntimeEvent) =>
      runtimeEventToActivities(event).map(({ id: _id, ...activity }) => activity);
    expect(normalize(makeClaudeEvent("evt-live-claude"))).toEqual(
      normalize(makeClaudeEvent("evt-replay-claude")),
    );
    expect(normalize(makeCodexEvent("evt-live-codex"))).toEqual(
      normalize(makeCodexEvent("evt-replay-codex")),
    );
    expect(normalize(makeClaudeEvent("evt-live-claude"))[0]).toMatchObject({
      kind: "tool.completed",
      payload: {
        agentId: "task-child-1",
        timelineBypass: true,
        renderDetail: {
          result: "Claude child result",
          changedFiles: [{ path: "src/claude.ts", kind: "modified" }],
          truncated: false,
        },
        detail: expect.stringMatching(/^.{177}\.\.\.$/s),
      },
    });
    expect(normalize(makeCodexEvent("evt-live-codex"))[0]).toMatchObject({
      kind: "tool.updated",
      payload: {
        agentId: "codex-child-thread-1",
        timelineBypass: true,
        renderDetail: {
          command: "vp test run src/codex.test.ts",
          changedFiles: [{ path: "src/codex.ts", diff: "+hello" }],
          truncated: false,
        },
        detail: expect.stringMatching(/^.{177}\.\.\.$/s),
      },
    });
    expect(normalize(makeClaudeEvent("evt-live-claude"))[0]?.payload).not.toHaveProperty("data");
    expect(normalize(makeCodexEvent("evt-live-codex"))[0]?.payload).not.toHaveProperty("data");
  });
  it("preserves the exact bounded render detail through activity projection", () => {
    const hostile = '\u0000\n"\\'.repeat(8000);
    const renderDetail = makeChildItemRenderDetail({
      workspaceRoot: "/workspace/project",
      command: hostile,
      result: hostile,
      changedFiles: [{ path: "/workspace/project/src/example.ts", diff: hostile }],
    });
    expect(renderDetail).toBeDefined();
    if (!renderDetail) return;
    const [activity] = runtimeEventToActivities({
      type: "item.completed",
      eventId: asEventId("evt-budgeted-detail"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      itemId: asItemId("codex-child-budgeted"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        agentId: "codex-child-thread-1",
        timelineBypass: true,
        renderDetail,
      },
    });
    expect(activity).toBeDefined();
    if (!activity) return;
    const projected = projectAgentActivity(activity);
    expect(
      (
        projected.payload as {
          renderDetail?: unknown;
        }
      ).renderDetail,
    ).toEqual(renderDetail);
    expect(childItemRenderDetailBytes(renderDetail)).toBeLessThanOrEqual(
      CHILD_ITEM_RENDER_JSON_MAX_BYTES,
    );
  });
});
