// Retries against the real orchestrator: a replayed request never acts on a
// thread the owner has since changed, and never reports a later run as its own,
// even when the attempt it retries committed and then lost its result.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationProjectShell,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  type RunId,
  RuntimeRequestId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import {
  type ProviderAdapterV2Event,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { checkpointWorkspace } from "../../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ExternalMcpService from "./ExternalMcpService.fork.ts";

const projectId = ProjectId.make("project:external-granted");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-test" } satisfies ModelSelection;

const principal: ExternalMcpService.ExternalMcpPrincipal = {
  sessionId: AuthSessionId.make("session-external"),
  subject: "device-authorization",
  clientLabel: "dot cloud",
  expiresAt: null,
  policy: {
    projectIds: [projectId],
    coordinate: true,
    maxRuntimeMode: "approval-required",
    maxInteractionMode: "plan",
  },
};

const provider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-05T00:00:00.000Z",
  models: [{ slug: "gpt-test", name: "gpt-test", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

/** Turns stay running until the test completes or interrupts them. */
const makeAdapter = () => {
  const started: Array<string> = [];
  const steered: Array<string> = [];
  const finishers = new Map<ThreadId, Effect.Effect<void>>();
  let held: Deferred.Deferred<void> | undefined;
  const steerSignals = new Map<string, Deferred.Deferred<void>>();
  const steerSignal = (text: string) => {
    const signal = steerSignals.get(text) ?? Deferred.makeUnsafe<void>();
    steerSignals.set(text, signal);
    return signal;
  };
  const adapter: ProviderAdapterV2Shape = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const publish = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const turnInputs = new Map<ProviderTurnId, ProviderAdapterV2TurnInput>();
        const finish = (providerTurnId: ProviderTurnId, status: "completed" | "interrupted") =>
          Effect.gen(function* () {
            const turn = turnInputs.get(providerTurnId);
            if (turn === undefined) return;
            turnInputs.delete(providerTurnId);
            finishers.delete(turn.threadId);
            const at = yield* DateTime.now;
            yield* publish([
              {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: { driver, nativeId: providerTurnId, strength: "strong" },
                  ordinal: turn.providerTurnOrdinal,
                  status,
                  startedAt: at,
                  completedAt: at,
                },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                status,
                failure: null,
                threadDisposition: "reusable",
              },
            ]);
          });
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeId = `codex:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              if (held !== undefined) yield* Deferred.await(held);
              started.push(turn.message.text);
              const at = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turn.threadId}:${turn.runOrdinal}:${turn.attemptId}`,
              );
              turnInputs.set(providerTurnId, turn);
              finishers.set(turn.threadId, finish(providerTurnId, "completed"));
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: { driver, nativeId: providerTurnId, strength: "strong" },
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: at,
                    completedAt: null,
                  },
                },
              ]);
            }),
          steerTurn: (steer) =>
            Effect.suspend(() => {
              steered.push(steer.message.text);
              return Deferred.succeed(steerSignal(steer.message.text), undefined);
            }),
          interruptTurn: ({ providerTurnId }) => finish(providerTurnId, "interrupted"),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            Effect.fail(new ProviderAdapterProtocolError({ driver, detail: "unused" })),
          rollbackThread: () =>
            Effect.fail(new ProviderAdapterProtocolError({ driver, detail: "unused" })),
          forkThread: () =>
            Effect.fail(new ProviderAdapterProtocolError({ driver, detail: "unused" })),
        };
      }),
  };
  /** Completes the thread's running turn, as the provider finishing would. */
  const complete = (threadId: ThreadId) => finishers.get(threadId) ?? Effect.void;
  /** Holds every later turn in its start until the returned release runs. */
  const holdStarts = Deferred.make<void>().pipe(
    Effect.map((gate) => {
      held = gate;
      return Effect.suspend(() => {
        held = undefined;
        return Deferred.succeed(gate, undefined);
      });
    }),
  );
  /** Waits until the provider has received the steer carrying `text`. */
  const steerReached = (text: string) => Deferred.await(steerSignal(text));
  return { adapter, started, steered, complete, holdStarts, steerReached };
};

const waitForProjection = (
  orchestrator: Orchestrator.OrchestratorV2Shape,
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      if (predicate(projection)) return projection;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${threadId}.`));
  });

const hasRun = (status: string) => (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.at(-1)?.status === status &&
  (status !== "running" || projection.providerTurns.at(-1)?.status === "running");

const harness = <A, E>(
  name: string,
  body: (input: {
    readonly service: ExternalMcpService.ExternalMcpServiceShape;
    readonly orchestrator: Orchestrator.OrchestratorV2Shape;
    readonly projections: ProjectionStore.ProjectionStoreV2Shape;
    readonly threadManagement: ThreadManagementService.ThreadManagementServiceShape;
    readonly provider: ReturnType<typeof makeAdapter>;
    /** Forgets every recorded result, as a crash after each commit would. */
    readonly loseResults: Effect.Effect<void>;
    /** Runs `step` once, just before the service's next matching command reaches the orchestrator. */
    readonly interleave: (
      matches: (command: OrchestrationV2ServerCommand) => boolean,
      step: Effect.Effect<void>,
    ) => void;
  }) => Effect.Effect<A, E>,
  settings: Partial<ServerSettingsValue> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const fake = makeAdapter();
      const registryLayer = ProviderAdapterRegistry.makeLayer([fake.adapter]);
      const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
        {
          name,
          runtimePolicyOverride: {
            cwd,
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        },
        registryLayer,
        { databaseLayer: SqlitePersistenceMemory },
      );
      const shell = {
        id: projectId,
        title: "granted",
        workspaceRoot: cwd,
        defaultModelSelection: null,
      } as unknown as OrchestrationProjectShell;
      let pending:
        | {
            readonly matches: (command: OrchestrationV2ServerCommand) => boolean;
            readonly step: Effect.Effect<void>;
          }
        | undefined;
      const interleave = (
        matches: (command: OrchestrationV2ServerCommand) => boolean,
        step: Effect.Effect<void>,
      ) => {
        pending = { matches, step };
      };
      const threadManagementLayer = Layer.effect(
        ThreadManagementService.ThreadManagementService,
        Effect.gen(function* () {
          const inner = yield* ThreadManagementService.ThreadManagementService;
          return {
            ...inner,
            dispatch: (command: OrchestrationV2ServerCommand) =>
              Effect.suspend(() => {
                const due = pending?.matches(command) ? pending : undefined;
                if (due !== undefined) pending = undefined;
                return due === undefined ? Effect.void : due.step;
              }).pipe(Effect.andThen(inner.dispatch(command))),
          };
        }),
      ).pipe(Layer.provide(ThreadManagementService.layer), Layer.provide(orchestratorLayer));
      const layer = Layer.mergeAll(
        orchestratorLayer,
        ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
        ExternalMcpService.layer.pipe(
          Layer.provideMerge(threadManagementLayer),
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              getShell: () => Effect.succeed(Option.some(shell)),
            }),
          ),
          Layer.provide(registryLayer),
          Layer.provide(makeProviderRegistryLayer([provider])),
          Layer.provide(
            ServerSettings.layerTest({ defaultModelSelection: modelSelection, ...settings }),
          ),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ).pipe(Layer.provide(NodeServices.layer));
      return yield* Effect.gen(function* () {
        const service = yield* ExternalMcpService.ExternalMcpServiceFork;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadManagement = yield* ThreadManagementService.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        const loseResults = sql`UPDATE auth_external_mcp_requests SET result_json = NULL`.pipe(
          Effect.asVoid,
          Effect.orDie,
        );
        return yield* body({
          service,
          orchestrator,
          projections,
          threadManagement,
          provider: fake,
          loseResults,
          interleave,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

describe("ExternalMcpServiceFork on the orchestrator", () => {
  it.live.each(["environment", "project"] as const)(
    "persists inherited high effort from %s settings when no target is supplied",
    (scope) => {
      const high = {
        ...modelSelection,
        options: [{ id: "reasoningEffort", value: "high" }],
      } satisfies ModelSelection;
      return harness(
        `external-mcp-${scope}-default`,
        ({ service, orchestrator }) =>
          Effect.gen(function* () {
            const created = yield* service.createThread(principal, {
              projectId,
              clientRequestId: "inherited-effort",
            });
            const persisted = yield* orchestrator.getThreadProjection(created.threadId);
            assert.deepEqual(persisted.thread.modelSelection, high);
            assert.isNull(created.runId);
          }),
        {
          projectSettingsFolded: true,
          ...(scope === "environment"
            ? { defaultModelSelection: high }
            : { projectSettingsOverrides: { [projectId]: { defaultModelSelection: high } } }),
        },
      );
    },
  );

  it.live("never prompts a created thread the owner has since raised", () =>
    harness("external-mcp-create-replay", ({ service, orchestrator, provider }) =>
      Effect.gen(function* () {
        const created = yield* service.createThread(principal, {
          projectId,
          clientRequestId: "k",
        });
        assert.isNull(created.runId);
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("command:owner:raise"),
          threadId: created.threadId,
          runtimeMode: "full-access",
        });
        yield* waitForProjection(
          orchestrator,
          created.threadId,
          (projection) => projection.thread.runtimeMode === "full-access",
        );

        // The same key now carrying a prompt is a different request.
        const prompted = yield* service
          .createThread(principal, { projectId, prompt: "go", clientRequestId: "k" })
          .pipe(Effect.flip);
        assert.equal(prompted.code, "invalid_request");
        // The original request replays its result without touching the thread.
        assert.deepEqual(
          yield* service.createThread(principal, { projectId, clientRequestId: "k" }),
          created,
        );
        // An attempt that created the thread but never recorded a result
        // re-validates the live thread before it starts a run.
        const lost = ThreadId.make("thread:mcp-external:session-external:create:lost");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make("command:mcp-external:session-external:create:lost"),
          threadId: lost,
          projectId,
          title: "go",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("command:owner:raise-lost"),
          threadId: lost,
          runtimeMode: "full-access",
        });
        yield* waitForProjection(
          orchestrator,
          lost,
          (projection) => projection.thread.runtimeMode === "full-access",
        );
        const resumed = yield* service
          .createThread(principal, { projectId, prompt: "go", clientRequestId: "lost" })
          .pipe(Effect.flip);
        assert.equal(resumed.code, "runtime_mode_escalation_denied");

        const projection = yield* orchestrator.getThreadProjection(lost);
        assert.equal(projection.runs.length, 0);
        assert.equal((yield* orchestrator.getThreadProjection(created.threadId)).runs.length, 0);
        assert.deepEqual(provider.started, []);
      }),
    ),
  );

  it.live("never starts a created thread's prompt once the owner raised it mid-create", () =>
    harness("external-mcp-create-race", ({ service, orchestrator, provider, interleave }) =>
      Effect.gen(function* () {
        // The owner's raise wins the thread lock after the service vetted the
        // new thread and before its prompt commits.
        interleave(
          (command) => command.type === "message.dispatch",
          Effect.gen(function* () {
            const threadId = ThreadId.make("thread:mcp-external:session-external:create:race");
            yield* orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("command:owner:raise-race"),
              threadId,
              runtimeMode: "full-access",
            });
            yield* waitForProjection(
              orchestrator,
              threadId,
              (projection) => projection.thread.runtimeMode === "full-access",
            );
          }).pipe(Effect.orDie),
        );
        const raced = yield* service
          .createThread(principal, { projectId, prompt: "go", clientRequestId: "race" })
          .pipe(Effect.flip);
        assert.equal(raced.code, "orchestration_error");
        const projection = yield* orchestrator.getThreadProjection(
          ThreadId.make("thread:mcp-external:session-external:create:race"),
        );
        assert.equal(projection.thread.runtimeMode, "full-access");
        assert.equal(projection.runs.length, 0);
        assert.deepEqual(provider.started, []);
        // A retry vets the raised thread and refuses it outright.
        const retried = yield* service
          .createThread(principal, { projectId, prompt: "go", clientRequestId: "race" })
          .pipe(Effect.flip);
        assert.equal(retried.code, "runtime_mode_escalation_denied");
        assert.deepEqual(provider.started, []);
      }),
    ),
  );

  it.live("replays a send after its run ended and an interrupt after a later run", () =>
    harness("external-mcp-send-replay", ({ service, orchestrator, provider }) =>
      Effect.gen(function* () {
        const created = yield* service.createThread(principal, {
          projectId,
          prompt: "first",
          clientRequestId: "create",
        });
        const threadId = created.threadId;
        const first = yield* waitForProjection(orchestrator, threadId, hasRun("running"));

        const steer = { threadId, message: "steer", mode: "steer", clientRequestId: "s" } as const;
        const steered = yield* service.sendToThread(principal, steer);
        assert.equal(steered.delivery, "steered");
        yield* provider.complete(threadId);
        yield* waitForProjection(orchestrator, threadId, hasRun("completed"));
        // No run is left to steer, but the retry is the same request.
        assert.deepEqual(yield* service.sendToThread(principal, steer), steered);
        assert.deepEqual(provider.steered, ["steer"]);

        const next = yield* service.sendToThread(principal, {
          threadId,
          message: "second",
          clientRequestId: "second",
        });
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        const interrupt = { threadId, clientRequestId: "i" } as const;
        const interrupted = yield* service.interruptThread(principal, interrupt);
        assert.equal(interrupted.runId, next.runId);
        yield* waitForProjection(orchestrator, threadId, hasRun("interrupted"));

        const third = yield* service.sendToThread(principal, {
          threadId,
          message: "third",
          clientRequestId: "third",
        });
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        // The retry reports the run it stopped and leaves the later one alone.
        assert.deepEqual(yield* service.interruptThread(principal, interrupt), interrupted);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.at(-1)?.id, third.runId);
        assert.equal(after.runs.at(-1)?.status, "running");
        assert.notEqual(first.runs[0]?.id, third.runId);
        assert.deepEqual(provider.started, ["first", "second", "third"]);
        assert.equal(
          after.messages.filter((message) => message.role === "user" && message.text === "steer")
            .length,
          1,
        );
      }),
    ),
  );

  it.live("recovers a send and an interrupt that committed but lost their result", () =>
    harness("external-mcp-crash-window", ({ service, orchestrator, provider, loseResults }) =>
      Effect.gen(function* () {
        const created = yield* service.createThread(principal, {
          projectId,
          prompt: "first",
          clientRequestId: "create",
        });
        const threadId = created.threadId;
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));

        const steer = { threadId, message: "steer", mode: "steer", clientRequestId: "s" } as const;
        const steered = yield* service.sendToThread(principal, steer);
        yield* provider.complete(threadId);
        yield* waitForProjection(orchestrator, threadId, hasRun("completed"));
        yield* loseResults;
        // The message already reached the ended run; the retry reports that run.
        assert.deepEqual(yield* service.sendToThread(principal, steer), {
          ...steered,
          status: "completed",
        });
        assert.deepEqual(provider.steered, ["steer"]);

        const next = yield* service.sendToThread(principal, {
          threadId,
          message: "second",
          clientRequestId: "second",
        });
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        const interrupt = { threadId, clientRequestId: "i" } as const;
        const interrupted = yield* service.interruptThread(principal, interrupt);
        assert.equal(interrupted.runId, next.runId);
        yield* waitForProjection(orchestrator, threadId, hasRun("interrupted"));
        const third = yield* service.sendToThread(principal, {
          threadId,
          message: "third",
          clientRequestId: "third",
        });
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        yield* loseResults;
        // The retry stays on the run it pinned and leaves the later one running.
        const retried = yield* service.interruptThread(principal, interrupt);
        assert.deepEqual(retried, { threadId, runId: next.runId, status: "interrupted" });
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.at(-1)?.id, third.runId);
        assert.equal(after.runs.at(-1)?.status, "running");
        assert.equal(
          after.messages.filter((message) => message.role === "user" && message.text === "steer")
            .length,
          1,
        );

        // A create that sent its prompt reports that run, not the latest one.
        yield* provider.complete(threadId);
        yield* waitForProjection(orchestrator, threadId, hasRun("completed"));
        yield* loseResults;
        const recreated = yield* service.createThread(principal, {
          projectId,
          prompt: "first",
          clientRequestId: "create",
        });
        assert.equal(recreated.runId, created.runId);

        // An interrupt that found no active run keeps that answer.
        const idle = { threadId, clientRequestId: "idle" } as const;
        const none = { threadId, runId: null, status: "no_active_run" } as const;
        assert.deepEqual(yield* service.interruptThread(principal, idle), none);
        yield* loseResults;
        const fourth = yield* service.sendToThread(principal, {
          threadId,
          message: "fourth",
          clientRequestId: "fourth",
        });
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        assert.deepEqual(yield* service.interruptThread(principal, idle), none);
        const latest = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(latest.runs.at(-1)?.id, fourth.runId);
        assert.equal(latest.runs.at(-1)?.status, "running");
        assert.deepEqual(provider.started, ["first", "second", "third", "fourth"]);
      }),
    ),
  );

  /** An owner thread whose elevated turn has been requested. */
  const startElevated = (orchestrator: Orchestrator.OrchestratorV2Shape, threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:owner:create"),
        threadId,
        projectId,
        title: "owner",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:owner:start"),
        threadId,
        messageId: MessageId.make("message:owner:start"),
        text: "elevated",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
    });

  /** The owner lowers the thread while its elevated turn goes on. */
  const lowerModes = (orchestrator: Orchestrator.OrchestratorV2Shape, threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("command:owner:lower"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("command:owner:plan"),
        threadId,
        interactionMode: "plan",
      });
      yield* waitForProjection(
        orchestrator,
        threadId,
        (projection) => projection.thread.interactionMode === "plan",
      );
    });

  it.live("never steers a turn that started before the owner changed the modes", () =>
    harness("external-mcp-steer-downgrade", ({ service, orchestrator, provider }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:owner-elevated");
        yield* startElevated(orchestrator, threadId);
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        yield* lowerModes(orchestrator, threadId);

        const refused = yield* service
          .sendToThread(principal, { threadId, message: "x", mode: "steer", clientRequestId: "s" })
          .pipe(Effect.flip);
        assert.equal(refused.code, "runtime_mode_escalation_denied");
        const queued = yield* service.sendToThread(principal, {
          threadId,
          message: "later",
          clientRequestId: "a",
        });
        assert.equal(queued.delivery, "queued");
        assert.deepEqual(provider.steered, []);
      }),
    ),
  );

  /** The running turn asks a question, answered live or as a later message. */
  const seedQuestion = (
    orchestrator: Orchestrator.OrchestratorV2Shape,
    projections: ProjectionStore.ProjectionStoreV2Shape,
    threadId: ThreadId,
    delivery: "live" | "message",
  ) =>
    Effect.gen(function* () {
      const requestId = RuntimeRequestId.make(`request:${delivery}`);
      const nodeId = NodeId.make(`fixture:node:${delivery}`);
      const now = yield* DateTime.now;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      yield* projections.apply({
        id: EventId.make(`fixture:request:${delivery}`),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability:
            delivery === "live"
              ? { type: "live", providerSessionId: projection.providerSessions[0]!.id }
              : { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`fixture:question:${delivery}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`fixture:item:${delivery}`),
          threadId,
          runId: projection.runs[0]!.id,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "pending",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "user_input_request",
          requestId,
          questions: [{ id: "next", header: "Next", question: "What next?", options: [] }],
          ...(delivery === "message" ? { responseMode: "message" as const } : {}),
        },
      });
      return requestId;
    });

  it.live("queues a capped answer behind a turn that started before the modes changed", () =>
    harness("external-mcp-answer-downgrade", ({ service, orchestrator, projections }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:owner-asks");
        yield* startElevated(orchestrator, threadId);
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        yield* lowerModes(orchestrator, threadId);
        const requestId = yield* seedQuestion(orchestrator, projections, threadId, "message");

        yield* service.respondToRequest(principal, { threadId, requestId, answers: { next: "x" } });
        const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
        assert.deepEqual(
          runs.map((run) => run.status),
          ["running", "queued"],
        );
      }),
    ),
  );

  it.live("never answers live a turn that started before the modes changed", () =>
    harness("external-mcp-live-answer-downgrade", ({ service, orchestrator, projections }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:owner-asks-live");
        yield* startElevated(orchestrator, threadId);
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        yield* lowerModes(orchestrator, threadId);
        const requestId = yield* seedQuestion(orchestrator, projections, threadId, "live");

        const refused = yield* service
          .respondToRequest(principal, { threadId, requestId, answers: { next: "x" } })
          .pipe(Effect.flip);
        assert.equal(refused.code, "runtime_mode_escalation_denied");
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runtimeRequests[0]?.status, "pending");
      }),
    ),
  );

  it.live("never steers an elevated turn that was still starting when the modes changed", () =>
    harness("external-mcp-steer-starting", ({ service, orchestrator, provider }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:owner-starting");
        const release = yield* provider.holdStarts;
        yield* startElevated(orchestrator, threadId);
        const starting = yield* waitForProjection(
          orchestrator,
          threadId,
          (projection) => projection.runs.length === 1 && projection.providerTurns.length === 0,
        );
        yield* lowerModes(orchestrator, threadId);

        const refused = yield* service
          .sendToThread(principal, { threadId, message: "x", mode: "steer", clientRequestId: "s" })
          .pipe(Effect.flip);
        assert.equal(refused.code, "runtime_mode_escalation_denied");
        yield* release;
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        const queued = yield* service.sendToThread(principal, {
          threadId,
          message: "later",
          clientRequestId: "a",
        });
        assert.equal(queued.delivery, "queued");
        assert.equal(
          starting.runs[0]?.id,
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.id,
        );
        assert.deepEqual(provider.started, ["elevated"]);
        assert.deepEqual(provider.steered, []);
      }),
    ),
  );

  it.live("refuses a vetted send once the owner changed the thread's modes", () =>
    harness("external-mcp-expected-modes", ({ orchestrator, provider }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:owner-modes");
        yield* startElevated(orchestrator, threadId);
        yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        yield* lowerModes(orchestrator, threadId);
        const vetted = yield* orchestrator.getThreadProjection(threadId);
        const attempt = vetted.runs[0]!.activeAttemptId!;
        const vettedModes = {
          runtimeMode: vetted.thread.runtimeMode,
          interactionMode: vetted.thread.interactionMode,
        };
        // The owner raises the thread after the send was vetted. A steer that
        // fell back to interrupt-and-restart would start a full-access attempt.
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("command:owner:raise"),
          threadId,
          runtimeMode: "full-access",
        });
        yield* waitForProjection(
          orchestrator,
          threadId,
          (projection) => projection.thread.runtimeMode === "full-access",
        );
        const send = (
          key: string,
          dispatchMode:
            | { readonly type: "steer_active"; readonly targetRunId: RunId }
            | { readonly type: "queue_after_active" },
          expectedModes: typeof vettedModes,
        ) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make(`command:modes:${key}`),
            threadId,
            messageId: MessageId.make(`message:modes:${key}`),
            text: key,
            attachments: [],
            dispatchMode,
            ...(dispatchMode.type === "steer_active" ? { steerAttemptId: attempt } : {}),
            expectedModes,
          });

        const steer = { type: "steer_active", targetRunId: vetted.runs[0]!.id } as const;
        const steered = yield* send("steer", steer, vettedModes).pipe(Effect.flip);
        assert.equal(steered._tag, "OrchestratorDispatchError");
        const queued = yield* send("queue", { type: "queue_after_active" }, vettedModes).pipe(
          Effect.flip,
        );
        assert.equal(queued._tag, "OrchestratorDispatchError");
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(
          projection.messages.some((message) => message.id.startsWith("message:modes")),
        );
        // The same send vetted under the current modes goes through.
        yield* send(
          "current",
          { type: "queue_after_active" },
          { runtimeMode: "full-access", interactionMode: "plan" },
        );
        assert.deepEqual(provider.started, ["elevated"]);
        assert.deepEqual(provider.steered, []);
      }),
    ),
  );

  it.live("joins only the attempt its caller vetted, even after a restart", () =>
    harness("external-mcp-steer-target", ({ orchestrator, threadManagement, provider }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:owner-target");
        yield* startElevated(orchestrator, threadId);
        const running = yield* waitForProjection(orchestrator, threadId, hasRun("running"));
        const vetted = running.runs[0]!.activeAttemptId!;
        const send = (key: string, mode: "auto" | "steer", steerTarget: RunAttemptId | null) =>
          threadManagement.sendToThread({
            projectId,
            commandId: CommandId.make(`command:target:${key}`),
            threadId,
            messageId: MessageId.make(`message:target:${key}`),
            text: key,
            attachments: [],
            mode,
            steerTarget,
            createdBy: "agent",
            creationSource: "mcp",
          });

        // A caller that saw no attempt, or another one, never joins this one.
        assert.equal((yield* send("none", "auto", null)).delivery, "queued");
        const stale = yield* send("stale", "steer", RunAttemptId.make("attempt:stale")).pipe(
          Effect.flip,
        );
        assert.equal(stale._tag, "ThreadManagementNoSteerableRunError");
        assert.deepEqual(provider.steered, []);
        assert.equal((yield* send("vetted", "auto", vetted)).delivery, "steered");
        yield* provider.steerReached("vetted");
        assert.deepEqual(provider.steered, ["vetted"]);

        // The owner restarts the run: same run id, new attempt.
        const runId = running.runs[0]!.id;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:owner:restart"),
          threadId,
          messageId: MessageId.make("message:owner:restart"),
          text: "restart",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "restart_active", targetRunId: runId },
        });
        const restarted = yield* waitForProjection(orchestrator, threadId, (projection) => {
          const attempt = projection.runs[0]?.activeAttemptId;
          return (
            attempt !== vetted &&
            projection.providerTurns.some(
              (turn) => turn.runAttemptId === attempt && turn.status === "running",
            )
          );
        });
        assert.equal(restarted.runs[0]?.id, runId);
        assert.equal((yield* send("after-restart", "auto", vetted)).delivery, "queued");
        const refused = yield* send("restart-steer", "steer", vetted).pipe(Effect.flip);
        assert.equal(refused._tag, "ThreadManagementNoSteerableRunError");
        // Dispatch itself refuses the old pin, so a send that vetted before the
        // restart cannot join the replacement attempt.
        const late = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make("command:target:late"),
            threadId,
            messageId: MessageId.make("message:target:late"),
            text: "late",
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: runId },
            steerAttemptId: vetted,
          })
          .pipe(Effect.flip);
        assert.equal(late._tag, "OrchestratorDispatchError");
        assert.deepEqual(provider.steered, ["vetted"]);
        const current = restarted.runs[0]!.activeAttemptId!;
        assert.equal((yield* send("current", "auto", current)).delivery, "steered");
        yield* provider.steerReached("current");
        assert.deepEqual(provider.steered, ["vetted", "current"]);
      }),
    ),
  );
});
