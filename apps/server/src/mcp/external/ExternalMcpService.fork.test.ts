import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ExternalMcpPolicy } from "../../auth/ExternalMcpGrant.fork.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ExternalMcpService from "./ExternalMcpService.fork.ts";

const granted = ProjectId.make("project:granted");
const other = ProjectId.make("project:other");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-test" };

const projectShell = (
  id: ProjectId,
  defaultModelSelection: ModelSelection | null = modelSelection,
) =>
  ({
    id,
    title: String(id),
    workspaceRoot: `/work/${id}`,
    defaultModelSelection,
  }) as unknown as OrchestrationProjectShell;

const provider = {
  instanceId,
  driver: "codex",
  enabled: true,
  installed: true,
  availability: "available",
  auth: { status: "authenticated" },
  models: [{ slug: "gpt-test" }],
} as unknown as ServerProvider;

const principal = (
  policy: Partial<ExternalMcpPolicy> = {},
  sessionId = "session-a",
): ExternalMcpService.ExternalMcpPrincipal => ({
  sessionId: AuthSessionId.make(sessionId),
  subject: "device-authorization",
  clientLabel: "dot cloud",
  expiresAt: null,
  policy: {
    projectIds: [granted],
    coordinate: true,
    maxRuntimeMode: "approval-required",
    maxInteractionMode: "plan",
    ...policy,
  },
});

/** Threads live in a map keyed by id; `thread.create` adds one, so a reload finds it. */
const makeHarness = (
  settings: Partial<ServerSettingsValue> = {},
  legacySelection: ModelSelection | null = modelSelection,
  providers: ReadonlyArray<ServerProvider> = [provider],
) => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
  // Flipped to make a send fail after it, as a thread whose run has ended would.
  const state = { sendFails: false, settings: { ...DEFAULT_SERVER_SETTINGS, ...settings } };
  const threads = new Map<
    string,
    { projectId: ProjectId; runtimeMode: string; interactionMode: string }
  >([
    [
      "thread:granted",
      { projectId: granted, runtimeMode: "approval-required", interactionMode: "plan" },
    ],
    [
      "thread:other",
      { projectId: other, runtimeMode: "approval-required", interactionMode: "plan" },
    ],
    ["thread:full", { projectId: granted, runtimeMode: "full-access", interactionMode: "plan" }],
  ]);
  const projection = (threadId: ThreadId) => {
    const thread = threads.get(threadId)!;
    return {
      thread: {
        id: threadId,
        projectId: thread.projectId,
        title: "t",
        deletedAt: null,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        modelSelection,
        createdBy: "agent",
        creationSource: "mcp",
      },
      runs: [],
      messages: [],
      turnItems: [],
      runtimeRequests: [],
      contextTransfers: [],
    } as unknown as OrchestrationV2ThreadProjection;
  };
  const layer = ExternalMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              threads.has(threadId)
                ? ({ id: threadId, projectId: threads.get(threadId)!.projectId } as never)
                : null,
            ),
          getProjectThreadRecords: (input) => Effect.succeed(projection(input.threadId) as never),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              if (command.type === "thread.create") {
                threads.set(command.threadId, {
                  projectId: command.projectId,
                  runtimeMode: command.runtimeMode,
                  interactionMode: command.interactionMode,
                });
              }
              return {} as never;
            }),
          sendToThread: (input) =>
            Effect.suspend(() => {
              if (state.sendFails) return Effect.die("send reached a terminal thread");
              sent.push(input);
              return Effect.succeed({
                run: { id: RunId.make("run:1"), status: "running" },
                delivery: "started",
              } as never);
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getShell: (projectId) =>
            Effect.succeed(Option.some(projectShell(projectId, legacySelection))),
          listShells: () => Effect.succeed([projectShell(granted), projectShell(other)]),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed(providers.map((entry) => entry.instanceId)),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.sync(() => state.settings),
        }),
        Layer.fresh(SqlitePersistenceMemory),
      ),
    ),
  );
  return { dispatched, sent, state, layer };
};

const run = <A, E>(
  harness: ReturnType<typeof makeHarness>,
  body: (service: ExternalMcpService.ExternalMcpServiceShape) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(ExternalMcpService.ExternalMcpServiceFork, body).pipe(
    Effect.provide(harness.layer),
  );

describe("ExternalMcpServiceFork", () => {
  it.effect(
    "inherits environment effort for a migrated project and reads changes on each launch",
    () => {
      const high = {
        instanceId,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      } satisfies ModelSelection;
      const medium = { ...high, options: [{ id: "reasoningEffort", value: "medium" }] };
      const harness = makeHarness(
        { defaultModelSelection: medium, projectSettingsFolded: true },
        null,
        [
          {
            ...provider,
            models: [{ slug: high.model, name: high.model, isCustom: false, capabilities: null }],
          },
        ],
      );
      return run(harness, (service) =>
        Effect.gen(function* () {
          yield* service.createThread(principal(), {
            projectId: granted,
            clientRequestId: "medium",
          });
          harness.state.settings = { ...harness.state.settings, defaultModelSelection: high };
          yield* service.createThread(principal(), { projectId: granted, clientRequestId: "high" });
          const selections = harness.dispatched.flatMap((command) =>
            command.type === "thread.create" ? [command.modelSelection] : [],
          );
          assert.deepEqual(selections, [medium, high]);
        }),
      );
    },
  );

  it.effect(
    "uses the current project provider and all its options over environment and legacy defaults",
    () => {
      const claudeId = ProviderInstanceId.make("claudeAgent");
      const high = {
        instanceId: claudeId,
        model: "claude-opus-5-5",
        options: [
          { id: "effort", value: "high" },
          { id: "contextWindow", value: "200k" },
        ],
      } satisfies ModelSelection;
      const harness = makeHarness(
        {
          defaultModelSelection: modelSelection,
          projectSettingsFolded: true,
          projectSettingsOverrides: { [granted]: { defaultModelSelection: high } },
        },
        modelSelection,
        [
          provider,
          {
            ...provider,
            instanceId: claudeId,
            driver: ProviderDriverKind.make("claudeAgent"),
            models: [{ slug: high.model, name: high.model, isCustom: false, capabilities: null }],
          },
        ],
      );
      return run(harness, (service) =>
        Effect.gen(function* () {
          yield* service.createThread(principal(), {
            projectId: granted,
            clientRequestId: "project",
          });
          const command = harness.dispatched[0];
          assert.equal(command?.type, "thread.create");
          if (command?.type !== "thread.create") return;
          assert.deepEqual(command.modelSelection, high);
        }),
      );
    },
  );

  it.effect("keeps external model option overrides unsupported", () => {
    const harness = makeHarness();
    return run(harness, (service) =>
      Effect.gen(function* () {
        const error = yield* service
          .createThread(principal(), {
            projectId: granted,
            clientRequestId: "options",
            target: { options: [{ id: "reasoningEffort", value: "high" }] },
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
        assert.equal(harness.dispatched.length, 0);
      }),
    );
  });

  it.effect.each(["missing", "signed out"] as const)(
    "falls back to a usable provider when the inherited default's provider is %s",
    (state) => {
      const claudeId = ProviderInstanceId.make("claudeAgent");
      const harness = makeHarness(
        {
          defaultModelSelection: { instanceId: claudeId, model: "claude-opus-5-5" },
          projectSettingsFolded: true,
        },
        null,
        state === "missing"
          ? [provider]
          : [
              provider,
              {
                ...provider,
                instanceId: claudeId,
                driver: ProviderDriverKind.make("claudeAgent"),
                auth: { status: "unauthenticated" },
              } as ServerProvider,
            ],
      );
      return run(harness, (service) =>
        Effect.gen(function* () {
          yield* service.createThread(principal(), { projectId: granted, clientRequestId: "gone" });
          const command = harness.dispatched[0];
          assert.equal(command?.type, "thread.create");
          if (command?.type !== "thread.create") return;
          assert.deepEqual(command.modelSelection, modelSelection);
        }),
      );
    },
  );

  it.effect("reaches only the projects and threads the grant names", () => {
    const harness = makeHarness();
    return run(harness, (service) =>
      Effect.gen(function* () {
        const projects = yield* service.listProjects(principal());
        assert.deepEqual(
          projects.map((project) => project.projectId),
          [granted],
        );
        const all = yield* service.listProjects(principal({ projectIds: "*" }));
        assert.equal(all.length, 2);

        const project = yield* service
          .listThreads(principal(), { projectId: other })
          .pipe(Effect.flip);
        assert.equal(project.code, "invalid_request");
        // A thread outside the grant reads as missing.
        const thread = yield* service
          .waitForThread(principal(), { threadId: ThreadId.make("thread:other") })
          .pipe(Effect.flip);
        assert.equal(thread.code, "thread_not_found");
        const created = yield* service
          .createThread(principal(), { projectId: other, clientRequestId: "a" })
          .pipe(Effect.flip);
        assert.equal(created.code, "invalid_request");
        assert.equal(harness.dispatched.length, 0);
      }),
    );
  });

  it.effect("refuses every mutation to a read-only grant", () => {
    const harness = makeHarness();
    const reader = principal({ coordinate: false });
    const threadId = ThreadId.make("thread:granted");
    return run(harness, (service) =>
      Effect.gen(function* () {
        for (const mutation of [
          Effect.asVoid(service.createThread(reader, { projectId: granted, clientRequestId: "a" })),
          Effect.asVoid(
            service.sendToThread(reader, { threadId, message: "hi", clientRequestId: "a" }),
          ),
          Effect.asVoid(service.interruptThread(reader, { threadId, clientRequestId: "a" })),
        ]) {
          assert.equal((yield* Effect.flip(mutation)).code, "capability_denied");
        }
        assert.equal(harness.dispatched.length, 0);
        assert.equal(harness.sent.length, 0);
      }),
    );
  });

  it.effect("holds threads under the grant's mode ceilings", () => {
    const harness = makeHarness();
    return run(harness, (service) =>
      Effect.gen(function* () {
        const runtime = yield* service
          .createThread(principal(), {
            projectId: granted,
            runtimeMode: "full-access",
            clientRequestId: "a",
          })
          .pipe(Effect.flip);
        assert.equal(runtime.code, "runtime_mode_escalation_denied");
        const interaction = yield* service
          .createThread(principal(), {
            projectId: granted,
            interactionMode: "default",
            clientRequestId: "b",
          })
          .pipe(Effect.flip);
        assert.equal(interaction.code, "interaction_mode_escalation_denied");
        // A thread the owner runs above the ceiling stays out of reach.
        const send = yield* service
          .sendToThread(principal(), {
            threadId: ThreadId.make("thread:full"),
            message: "hi",
            clientRequestId: "a",
          })
          .pipe(Effect.flip);
        assert.equal(send.code, "runtime_mode_escalation_denied");
        assert.equal(harness.dispatched.length, 0);
        assert.equal(harness.sent.length, 0);

        // A refused request still binds its key, so a changed request needs a new one.
        const reused = yield* service
          .createThread(principal(), { projectId: granted, clientRequestId: "a" })
          .pipe(Effect.flip);
        assert.equal(reused.code, "invalid_request");
        const created = yield* service.createThread(principal(), {
          projectId: granted,
          clientRequestId: "c",
        });
        const create = harness.dispatched[0];
        assert.equal(create?.type, "thread.create");
        if (create?.type !== "thread.create") return;
        // Unset modes default to the ceilings, never above them.
        assert.equal(create.runtimeMode, "approval-required");
        assert.equal(create.interactionMode, "plan");
        assert.equal(create.createdBy, "agent");
        assert.equal(create.creationSource, "mcp");
        assert.equal(created.threadId, create.threadId);
      }),
    );
  });

  it.effect("replays a retried request and refuses a reused key", () => {
    const harness = makeHarness();
    const threadId = ThreadId.make("thread:granted");
    return run(harness, (service) =>
      Effect.gen(function* () {
        const create = (sessionId: string, clientRequestId: string, prompt = "start") =>
          service.createThread(principal({}, sessionId), {
            projectId: granted,
            prompt,
            clientRequestId,
          });
        const first = yield* create("session-a", "req-1");
        // thread.create and message.dispatch.
        assert.equal(harness.dispatched.length, 2);
        const retried = yield* create("session-a", "req-1");
        assert.deepEqual(retried, first);
        assert.equal(harness.dispatched.length, 2);
        const changed = yield* create("session-a", "req-1", "other").pipe(Effect.flip);
        assert.equal(changed.code, "invalid_request");
        assert.equal(harness.dispatched.length, 2);
        const next = yield* create("session-a", "req-2");
        const otherSession = yield* create("session-b", "req-1");
        assert.notEqual(first.threadId, next.threadId);
        assert.notEqual(first.threadId, otherSession.threadId);
        assert.equal(new Set(harness.dispatched.map((command) => command.commandId)).size, 6);

        const send = (clientRequestId: string, message = "hi") =>
          service.sendToThread(principal(), { threadId, message, clientRequestId });
        const sentFirst = yield* send("req-1");
        assert.equal(harness.sent[0]?.createdBy, "agent");
        assert.equal(harness.sent[0]?.creationSource, "mcp");
        // The retry replays the stored result even once the thread could no longer take it.
        harness.state.sendFails = true;
        const sentRetry = yield* send("req-1");
        assert.deepEqual(sentRetry, sentFirst);
        assert.equal(harness.sent.length, 1);
        assert.equal((yield* send("req-1", "changed").pipe(Effect.flip)).code, "invalid_request");
      }),
    );
  });

  it.effect("holds interrupt under the grant's ceilings", () => {
    const harness = makeHarness();
    return run(harness, (service) =>
      Effect.gen(function* () {
        const interrupt = yield* service
          .interruptThread(principal(), {
            threadId: ThreadId.make("thread:full"),
            clientRequestId: "a",
          })
          .pipe(Effect.flip);
        assert.equal(interrupt.code, "runtime_mode_escalation_denied");
        assert.equal(harness.dispatched.length, 0);
      }),
    );
  });
});
