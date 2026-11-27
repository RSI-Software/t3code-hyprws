// Fork-only (colleague-collab): the collaborator tests' in-memory database and mocked host services.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import {
  CollaboratorSetTypingInputFork,
  CollaboratorSubmitMessageInputFork,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { ensureForkSchema } from "../persistence/ForkSchema.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

import * as CollaboratorShares from "./CollaboratorShares.fork.ts";

export const shared = ThreadId.make("shared");
export const other = ThreadId.make("other");
export const sharedProject = ProjectId.make("p-shared");
export const otherProject = ProjectId.make("p-other");
export const projectOf = { [shared]: sharedProject, [other]: otherProject } as Record<
  string,
  ProjectId
>;
export const pairedSubjects = new Set<string>();
export const pairingLabels: Array<string> = [];
export const decodeSetTyping = Schema.decodeExit(CollaboratorSetTypingInputFork);
export const decodeSubmitMessage = Schema.decodeEffect(CollaboratorSubmitMessageInputFork);

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const instanceId = ProviderInstanceId.make("codex");
export const threadShell = (id: ThreadId): OrchestrationV2ThreadShell => ({
  id,
  projectId: projectOf[id]!,
  title: `Thread ${id}`,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

export const hostDispatches: Array<OrchestrationV2Command> = [];
// Queued runs by id, with the attribution the server stored on each message; none is the host.
const queuedAttributions: Record<string, object | undefined> = {
  "run-sam": { name: "Sam" },
  "run-pat": { name: "Pat" },
  "run-host": undefined,
  "run-reply": { name: "Jordan Lee", host: true, replyTo: { name: "Sam", text: "pair at 3?" } },
};
const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed(threadShell(ThreadId.make(threadId))),
  getThreadRecords: (_threadId, _fields, filter) =>
    Effect.succeed({
      runs: (filter?.runIds ?? [])
        .filter((id) => id in queuedAttributions)
        .map((id) => ({ id, userMessageId: `message-${id}` })),
    } as never),
  getMessagesById: (_threadId, messageIds) =>
    Effect.succeed(
      new Map(
        messageIds.map((id) => {
          const collaboratorFork = queuedAttributions[id.replace("message-", "")];
          return [id, { context: collaboratorFork && { collaboratorFork } }];
        }),
      ) as never,
    ),
  // Yields first, as a real dispatch does, so concurrent sends interleave.
  dispatch: (command) =>
    Effect.yieldNow.pipe(
      Effect.andThen(Effect.sync(() => hostDispatches.push(command as OrchestrationV2Command))),
      Effect.as({} as never),
    ),
});
// Sent commands are accepted; a test may file a rejected one here.
export const rejectedReceipts = new Set<string>();
const receipts = Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
  getByCommandId: (commandId) =>
    Effect.sync(() => {
      const accepted = hostDispatches.some((command) => command.commandId === commandId);
      return accepted || rejectedReceipts.has(commandId)
        ? Option.some({ threadId: shared, status: accepted ? "accepted" : "rejected" } as never)
        : Option.none();
    }),
});
const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  createPairingLink: (input) =>
    Effect.sync(() => pairingLabels.push(input?.label ?? "")).pipe(
      Effect.as({ credential: "token" } as never),
    ),
  listSessions: () => Effect.succeed([...pairedSubjects].map((subject) => ({ subject }) as never)),
});
const config = Layer.succeed(ServerConfig.ServerConfig, {
  host: "127.0.0.1",
  port: 3773,
  privateNetworkOnly: false,
  devUrl: undefined,
  cwd: "/",
} as never as ServerConfig.ServerConfig["Service"]);
// The host's git user.name, which the agent reads in shared threads.
export const HOST = "Jordan Lee";
const git = Layer.mock(GitVcsDriver.GitVcsDriver)({
  execute: () => Effect.succeed({ stdout: `${HOST}\n` } as never),
});

// Project events wake the team marks; the team test supplies the queue.
export const projectEvents: { queue?: Queue.Queue<object, Error> } = {};
const events = Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
  latestApplicationSequence: Effect.succeed(0),
  streamApplicationEvents: () =>
    projectEvents.queue ? (Stream.fromQueue(projectEvents.queue) as never) : Stream.never,
});

export const database = it.layer(
  Layer.mergeAll(
    NodeSqliteClient.layer({ filename: ":memory:" }),
    NodeCrypto.layer,
    threads,
    receipts,
    auth,
    config,
    git,
    events,
  ),
);
export type Ingress = ReadonlyArray<{ hostname?: string; path?: string; service: string }>;

// A local cloudflared answering on its first metrics port with these ingress rules, or none.
export const tunnelClient = (ingress?: Ingress) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      ingress !== undefined && request.url === "http://127.0.0.1:20241/config"
        ? Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ config: { ingress } })),
          )
        : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
    ),
  );

export const withService = <A, E, R>(effect: Effect.Effect<A, E, R>, tunnel?: Ingress) =>
  Effect.andThen(
    ensureForkSchema(),
    Effect.provide(effect, CollaboratorShares.layer.pipe(Layer.provide(tunnelClient(tunnel)))),
  );
