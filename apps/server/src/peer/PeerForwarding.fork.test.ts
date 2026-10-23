import { forkSupersedes } from "../../../../scripts/lib/fork-supersedes.ts";

import * as DocumentText from "../provider/DocumentText.ts";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type SourceControlCloneRepositoryInput,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const boxProject = ProjectId.make("project:box");
const boxThread = ThreadId.make("thread:box-auto");
const boxRun = RunId.make("run:box-auto");

/** What B's thread service was asked to do. */
interface Seen {
  readonly sends: ReadonlyArray<ThreadManagement.ThreadManagementSendInput>;
  readonly waits: ReadonlyArray<ThreadManagement.ThreadManagementWaitInput>;
  readonly launches: ReadonlyArray<ThreadLaunch.ThreadLaunchInput>;
  readonly projects: ReadonlyArray<ProjectService.ProjectCreateInput>;
  readonly clones: ReadonlyArray<SourceControlCloneRepositoryInput>;
  /** Commands dispatched and delegated-task stops, as `<type> <threadId>`. */
  readonly stops: ReadonlyArray<string>;
}
const nothingSeen: Seen = {
  sends: [],
  waits: [],
  launches: [],
  projects: [],
  clones: [],
  stops: [],
};

/** The box user's own thread, which no link started. */
const usersThread = ThreadId.make("thread:box-users-own");

/**
 * B's threads: one `auto` thread in `boxProject` that the laptop's link
 * started, whose run finishes on the third wait, and the box user's own.
 * Every send and wait is recorded.
 */
const boxThreads = (seen: Ref.Ref<Seen>, linkSession: Ref.Ref<string>) => {
  const base = { ...liveThreadShell(boxThread, { runtimeMode: "auto" }), projectId: boxProject };
  const linked = Ref.get(linkSession).pipe(
    Effect.map((sessionId) => ({ ...base, linkOrigin: { sessionId, label: "T3 Code · Laptop" } })),
  );
  const users = { ...liveThreadShell(usersThread, { runtimeMode: "auto" }), projectId: boxProject };
  const run = (status: OrchestrationV2Run["status"]) =>
    ({ id: boxRun, status }) as unknown as OrchestrationV2Run;
  const shellOf = (threadId: ThreadId): Effect.Effect<OrchestrationV2ThreadShell | null> =>
    threadId === boxThread ? linked : Effect.succeed(threadId === usersThread ? users : null);
  const projectionOf = (threadId: ThreadId) =>
    shellOf(threadId).pipe(
      Effect.map((thread) => ({ thread, runs: [run("running")], runtimeRequests: [] }) as never),
    );
  return Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: shellOf,
    getProjectThreadRecords: (input) => projectionOf(input.threadId),
    getThreadRecords: (threadId) => projectionOf(threadId),
    listProjectThreads: () => linked.pipe(Effect.map((shell) => [shell] as never)),
    sendToThread: (input) =>
      Ref.update(seen, (current) => ({ ...current, sends: [...current.sends, input] })).pipe(
        Effect.as({ run: run("running"), delivery: "started" } as never),
      ),
    dispatch: (command) =>
      Ref.update(seen, (current) => ({
        ...current,
        stops: [
          ...current.stops,
          `${command.type} ${"threadId" in command ? command.threadId : ""}`,
        ],
      })).pipe(
        // The stop asks the provider to interrupt the thread's running turn.
        Effect.as({
          sequence: 0,
          storedEvents: [
            {
              sequence: 1,
              commandId: command.commandId,
              event: {
                type: "turn-item.updated",
                runId: boxRun,
                payload: {
                  type: "run_interrupt_request",
                  providerTurnId: "provider-turn:box-auto",
                },
              },
            },
          ],
        } as never),
      ),
    stopDelegatedTasks: (input) =>
      Ref.update(seen, (current) => ({
        ...current,
        stops: [...current.stops, `delegated-tasks.stop ${input.threadId}`],
      })),
    waitForThread: (input) =>
      Ref.updateAndGet(seen, (current) => ({ ...current, waits: [...current.waits, input] })).pipe(
        Effect.map(({ waits }) => ({
          threadId: input.threadId,
          run: run(waits.length < 3 ? "running" : "completed"),
          timedOut: waits.length < 3,
        })),
      ),
  });
};

/** B launches whatever it is asked to, and records it. */
const boxLaunches = (seen: Ref.Ref<Seen>) =>
  Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Ref.update(seen, (current) => ({ ...current, launches: [...current.launches, input] })).pipe(
        Effect.as({
          threadId: input.threadId,
          projection: {
            thread: {
              id: input.threadId,
              projectId: input.projectId,
              modelSelection: input.modelSelection,
              title: input.title,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult),
      ),
  });

/** B clones and registers whatever it is asked to, and records it. */
const boxProjects = (seen: Ref.Ref<Seen>) =>
  Layer.merge(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedNone,
      create: (input) =>
        Ref.update(seen, (current) => ({
          ...current,
          projects: [...current.projects, input],
        })).pipe(
          Effect.as({
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-18T00:00:00.000Z",
            updatedAt: "2026-10-18T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      cloneRepository: (input) =>
        Ref.update(seen, (current) => ({ ...current, clones: [...current.clones, input] })).pipe(
          Effect.as({
            cwd: input.destinationPath,
            remoteUrl: "https://github.com/pingdotgg/t3code.git",
            repository: null,
          }),
        ),
    }),
  );

/**
 * The orchestrator and project toolkits on B's real `/mcp`, behind its real
 * OAuth. `linkSession` is filled in once A links, so B's fixture thread reads
 * as one that link started.
 */
const serveBox = (seen: Ref.Ref<Seen>, linkSession: Ref.Ref<string>) =>
  servePeer(
    box,
    Layer.mergeAll(
      McpHttpServer.layerOrchestratorToolkit,
      McpHttpServer.layerProjectRegistration,
      McpHttpServer.layerThreadToolkit,
    ).pipe(
      Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(boxThreads(seen, linkSession)),
      Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
      Layer.provide(boxLaunches(seen)),
      Layer.provide(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(boxProjects(seen)),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-forwarding-box-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
      Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    ),
  );

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "peer-forwarding-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "peer-forwarding-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/**
 * Environment A: its own orchestrator toolkit with forwarding, and a thread
 * caller whose modes the test picks. Its local threads never matter here.
 */
const makeLaptop = Effect.gen(function* () {
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  const layerHere = Layer.mergeAll(
    McpHttpServer.layerOrchestratorToolkit,
    McpHttpServer.layerProjectRegistration,
    McpHttpServer.layerThreadToolkit,
  ).pipe(
    Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-forwarding-laptop-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(PeerForwarding.layer),
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            threadId === ThreadId.make("thread:laptop-from-desk")
              ? {
                  ...liveThreadShell(threadId, { runtimeMode: "full-access" }),
                  // Work another environment's link started on this laptop.
                  linkOrigin: { sessionId: "session:desk", label: "T3 Code · Desk" },
                }
              : liveThreadShell(
                  threadId,
                  threadId === ThreadId.make("thread:laptop-plan")
                    ? { runtimeMode: "full-access", interactionMode: "plan" }
                    : { runtimeMode: "full-access" },
                ),
          ),
        getProjectThreadRecords: ({ threadId }) =>
          Effect.succeed({
            thread: liveThreadShell(threadId, { runtimeMode: "full-access" }),
          } as never),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        ServerSettings.layerTest(),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
      ),
    ),
    Layer.fresh,
  );
  const here = yield* Layer.build(layerHere);
  const server = Context.get(here, McpServer.McpServer);
  const scopeOf = (
    caller: string,
    capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["orchestration"]),
  ): McpInvocationContext.McpInvocationScope => ({
    environmentId: laptop.environmentId,
    requestNamespace: `provider-session:${caller}`,
    thread: {
      threadId: ThreadId.make(caller),
      providerSessionId: `provider-session:${caller}`,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities,
    issuedAt: 1,
  });
  const call = (
    caller: string,
    name: string,
    args: Record<string, unknown>,
    capabilities?: ReadonlySet<McpInvocationContext.McpCapability>,
  ) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          scopeOf(caller, capabilities),
        ),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  return { links: Context.get(linking, PeerLinks.PeerLinks), call };
});

forkSupersedes({
  upstream:
    "apps/server/src/peer/PeerForwarding.test.ts > keeps a forwarded wait short and its retries scoped to the caller",
  reason:
    "Thread waits include pending-request and background-work metadata without changing peer retries or caller isolation.",
  commit: "b7b6592383",
});

it.effect("keeps forwarded wait metadata, short retries, and caller scoping", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const waited = yield* a.call("thread:laptop-full", "t3_thread_wait", {
        environmentId: box.environmentId,
        threadId: boxThread,
        timeoutMs: 600_000,
      });
      expect(waited.structuredContent).toEqual({
        threadId: boxThread,
        runId: boxRun,
        status: "completed",
        timedOut: false,
        pendingRequestCount: 0,
        work: {
          state: "idle",
          nativeTurn: null,
          background: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      // Three pieces of at most 50 s each, the later ones pinned to the run
      // the first one found.
      expect(
        (yield* Ref.get(seen)).waits.map(({ timeoutMs, runId }) => [timeoutMs, runId]),
      ).toEqual([
        [PeerForwarding.FORWARDED_WAIT_CHUNK_MS, undefined],
        [PeerForwarding.FORWARDED_WAIT_CHUNK_MS, boxRun],
        [PeerForwarding.FORWARDED_WAIT_CHUNK_MS, boxRun],
      ]);

      const send = (caller: string, clientRequestId: string) =>
        a.call(caller, "t3_thread_send", {
          environmentId: box.environmentId,
          threadId: boxThread,
          message: "Once.",
          clientRequestId,
        });
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-other", "same-key");
      const [first, retried, other] = (yield* Ref.get(seen)).sends.map((input) => input.commandId);
      // The box sees every caller here as the one link, so the key is scoped
      // to its caller before it leaves: a retry matches, another agent's same
      // key does not.
      expect(retried).toBe(first);
      expect(other).not.toBe(first);
      expect(first).not.toContain("same-key");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
