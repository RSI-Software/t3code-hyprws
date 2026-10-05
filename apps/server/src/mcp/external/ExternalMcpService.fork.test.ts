import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type OrchestrationProjectShell,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import type { ExternalMcpPolicy } from "../../auth/ExternalMcpGrant.fork.ts";
import * as ExternalMcpService from "./ExternalMcpService.fork.ts";

const granted = ProjectId.make("project:granted");
const other = ProjectId.make("project:other");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-test" };

const projectShell = (id: ProjectId) =>
  ({
    id,
    title: String(id),
    workspaceRoot: `/work/${id}`,
    defaultModelSelection: modelSelection,
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
const makeHarness = () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
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
            Effect.sync(() => {
              sent.push(input);
              return {
                run: { id: RunId.make("run:1"), status: "running" },
                delivery: "started",
              } as never;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getShell: (projectId) => Effect.succeed(Option.some(projectShell(projectId))),
          listShells: () => Effect.succeed([projectShell(granted), projectShell(other)]),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([instanceId]),
        }),
      ),
    ),
  );
  return { dispatched, sent, layer };
};

const run = <A, E>(
  harness: ReturnType<typeof makeHarness>,
  body: (service: ExternalMcpService.ExternalMcpServiceShape) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(ExternalMcpService.ExternalMcpServiceFork, body).pipe(
    Effect.provide(harness.layer),
  );

describe("ExternalMcpServiceFork", () => {
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
            clientRequestId: "a",
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

        const created = yield* service.createThread(principal(), {
          projectId: granted,
          clientRequestId: "a",
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

  it.effect("derives retry-stable ids from the session and request key", () => {
    const harness = makeHarness();
    const threadId = ThreadId.make("thread:granted");
    return run(harness, (service) =>
      Effect.gen(function* () {
        const create = (sessionId: string, clientRequestId: string) =>
          service.createThread(principal({}, sessionId), {
            projectId: granted,
            prompt: "start",
            clientRequestId,
          });
        const first = yield* create("session-a", "req-1");
        const retried = yield* create("session-a", "req-1");
        const next = yield* create("session-a", "req-2");
        const otherSession = yield* create("session-b", "req-1");
        assert.equal(first.threadId, retried.threadId);
        assert.notEqual(first.threadId, next.threadId);
        assert.notEqual(first.threadId, otherSession.threadId);
        const commandIds = harness.dispatched.map((command) => command.commandId);
        // thread.create and message.dispatch each, per call.
        assert.equal(commandIds.length, 8);
        assert.equal(commandIds[0], commandIds[2]);
        assert.equal(commandIds[1], commandIds[3]);
        assert.notEqual(commandIds[0], commandIds[1]);
        assert.equal(new Set(commandIds).size, 6);

        const send = (clientRequestId: string) =>
          service.sendToThread(principal(), { threadId, message: "hi", clientRequestId });
        const sentFirst = yield* send("req-1");
        const sentRetry = yield* send("req-1");
        assert.equal(sentFirst.messageId, sentRetry.messageId);
        assert.equal(harness.sent[0]?.commandId, harness.sent[1]?.commandId);
        assert.equal(harness.sent[0]?.createdBy, "agent");
        assert.equal(harness.sent[0]?.creationSource, "mcp");
      }),
    );
  });
});
