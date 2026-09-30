// Fork-owned WebSocket cases for thread ↔ GitHub issue links
// (RSI-Software/t3code-hyprws#1431). `server.test.ts` registers them inside its
// router seam suite through one `github-issues/*` hook, so they reuse its app
// harness without adding test blocks to the upstream file.
//
// Link changes reach live clients through the shell stream: each issue event
// refetches the thread shell, which carries `issues`. The detail stream forwards
// no issue event, like pull request links, so a client from before issue links
// never meets an event type its closed union cannot decode.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type { Vitest } from "@effect/vitest";
import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationEvent,
  OrchestrationShellStreamItem,
  OrchestrationThread,
  OrchestrationThreadShell,
  OrchestrationThreadStreamItem,
  THREAD_ISSUE_EVENT_TYPES_FORK,
  WsRpcGroup,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as TestClock from "effect/testing/TestClock";
import { RpcClient } from "effect/unstable/rpc";

import type * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import type * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, unknown, unknown> ? Client : never;

type HarnessServices<R> = R | Scope.Scope | Layer.Success<typeof NodeHttpServer.layerTest>;

/** The `server.test.ts` helpers these cases drive. */
export interface ThreadIssueStreamHarnessFork<R, BuildError, UrlError, ClientError> {
  readonly buildAppUnderTest: (options: {
    readonly layers: {
      readonly orchestrationEngine: Partial<
        OrchestrationEngine.OrchestrationEngineService["Service"]
      >;
      readonly projectionSnapshotQuery: Partial<
        ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]
      >;
    };
  }) => Effect.Effect<unknown, BuildError, HarnessServices<R>>;
  readonly getWsServerUrl: (
    pathname: string,
  ) => Effect.Effect<string, UrlError, HarnessServices<R>>;
  readonly withWsRpcClient: <A, E>(
    wsUrl: string,
    f: (client: WsRpcClient) => Effect.Effect<A, E, Scope.Scope>,
  ) => Effect.Effect<A, E | ClientError, HarnessServices<R>>;
  readonly makeThread: () => OrchestrationThread;
  readonly makeThreadShell: () => OrchestrationThreadShell;
}

// A client from before issue links: the same schemas without the fork's
// `issues` field and issue events.
const issueEventTypes: ReadonlyArray<string> = THREAD_ISSUE_EVENT_TYPES_FORK;
const PreFeatureEvent = Schema.Union(
  OrchestrationEvent.members.filter(
    (member) => !issueEventTypes.includes(member.fields.type.literal),
  ),
);
const PreFeatureThread = OrchestrationThread.mapFields(Struct.omit(["issues"]));
const PreFeatureThreadShell = OrchestrationThreadShell.mapFields(Struct.omit(["issues"]));
const encodeThreadShell = Schema.encodeEffect(OrchestrationThreadShell);
const decodePreFeatureThreadShell = Schema.decodeEffect(PreFeatureThreadShell);
const encodeThreadStreamItem = Schema.encodeEffect(OrchestrationThreadStreamItem);
const PreFeatureThreadStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: Schema.Struct({ snapshotSequence: Schema.Number, thread: PreFeatureThread }),
  }),
  Schema.Struct({ kind: Schema.Literal("event"), event: PreFeatureEvent }),
]);

const decodePreFeatureThreadStreamItem = Schema.decodeEffect(PreFeatureThreadStreamItem);

const link: ThreadIssueLink = {
  host: "github.com",
  repository: "acme/web",
  number: 7,
  url: "https://github.com/acme/web/issues/7",
  source: "manual",
  linkedAt: "2026-01-01T00:00:01.000Z",
  snapshot: null,
};

const eventBase = (threadId: string, sequence: number) => ({
  sequence,
  eventId: EventId.make(`issue-stream-event-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: "2026-01-01T00:00:01.000Z",
  commandId: CommandId.make(`issue-stream-command-${sequence}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);

const linkedEvent = (threadId: string, sequence: number) =>
  decodeEvent({
    ...eventBase(threadId, sequence),
    type: "thread.issue-linked",
    payload: { threadId, link, updatedAt: link.linkedAt },
  });

const unlinkedEvent = (threadId: string, sequence: number) =>
  decodeEvent({
    ...eventBase(threadId, sequence),
    type: "thread.issue-unlinked",
    payload: {
      threadId,
      host: link.host,
      repository: link.repository,
      number: link.number,
      updatedAt: link.linkedAt,
    },
  });

export const threadIssueStreamTestsFork = <R, BuildError, UrlError, ClientError>(
  it: Vitest.MethodsNonLive<R>,
  harness: ThreadIssueStreamHarnessFork<R, BuildError, UrlError, ClientError>,
) => {
  it.effect("shell subscribers refetch a thread on issue link changes an old client reads", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const unlinked = harness.makeThreadShell();
      const linked: OrchestrationThreadShell = { ...unlinked, issues: [link] };
      let current = unlinked;
      yield* harness.buildAppUnderTest({
        layers: {
          orchestrationEngine: { streamDomainEvents: Stream.fromPubSub(liveEvents) },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                projects: [],
                threads: [current],
                updatedAt: link.linkedAt,
              }),
            getThreadShellById: () => Effect.succeedSome(current),
          },
        },
      });

      // Publish each change once the previous one has reached the client, so
      // the shell coalescing window cannot merge them into one refetch.
      const advance = (item: OrchestrationShellStreamItem) => {
        if (item.kind === "synchronized") {
          current = linked;
          return PubSub.publish(liveEvents, linkedEvent(unlinked.id, 2));
        }
        if (item.kind === "thread-upserted" && item.sequence === 2) {
          current = unlinked;
          return PubSub.publish(liveEvents, unlinkedEvent(unlinked.id, 3));
        }
        return Effect.void;
      };
      const wsUrl = yield* harness.getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        harness.withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ requestCompletionMarker: true }).pipe(
            Stream.tap(advance),
            Stream.takeUntil((item) => item.kind === "thread-upserted" && item.sequence === 3),
            Stream.runCollect,
          ),
        ),
      ).pipe(Effect.timeout("5 seconds"));

      const upserts = items.flatMap((item) => (item.kind === "thread-upserted" ? [item] : []));
      assert.deepStrictEqual(
        upserts.map((item) => [item.sequence, item.thread.issues]),
        [
          [2, [link]],
          [3, undefined],
        ],
      );
      assert.isFalse("issues" in upserts[1]!.thread);

      for (const { thread } of upserts) {
        const old = yield* decodePreFeatureThreadShell(yield* encodeThreadShell(thread));
        assert.isFalse("issues" in old);
        assert.strictEqual(old.id, unlinked.id);
      }
    }).pipe(
      Effect.provide(NodeHttpServer.layerTest),
      // The shell stream's coalescing window runs on the clock.
      TestClock.withLive,
    ),
  );

  it.effect("detail subscribers get no issue events, so an old client decodes every item", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const thread: OrchestrationThread = { ...harness.makeThread(), issues: [link] };
      const messageEvent = decodeEvent({
        ...eventBase(thread.id, 4),
        type: "thread.message-sent",
        payload: {
          threadId: thread.id,
          messageId: MessageId.make("issue-stream-message"),
          role: "user",
          text: "After the link changes",
          turnId: null,
          streaming: false,
          createdAt: link.linkedAt,
          updatedAt: link.linkedAt,
        },
      });
      yield* harness.buildAppUnderTest({
        layers: {
          orchestrationEngine: { streamDomainEvents: Stream.fromPubSub(liveEvents) },
          projectionSnapshotQuery: {
            // Link and unlink land while the subscriber loads its snapshot.
            getThreadDetailSnapshot: () =>
              PubSub.publishAll(liveEvents, [
                linkedEvent(thread.id, 2),
                unlinkedEvent(thread.id, 3),
                messageEvent,
              ]).pipe(Effect.as(Option.some({ snapshotSequence: 1, thread }))),
          },
        },
      });

      const wsUrl = yield* harness.getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        harness.withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: thread.id,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      ).pipe(Effect.timeout("5 seconds"));

      assert.deepStrictEqual(
        items.map((item) => (item.kind === "event" ? item.event.sequence : item.kind)),
        ["snapshot", 4, "synchronized"],
      );
      const snapshot = items[0];
      assert.deepStrictEqual(
        snapshot?.kind === "snapshot" ? snapshot.snapshot.thread.issues : null,
        [link],
      );

      for (const item of items) {
        const old = yield* decodePreFeatureThreadStreamItem(yield* encodeThreadStreamItem(item));
        if (old.kind === "snapshot") assert.isFalse("issues" in old.snapshot.thread);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a sync for an unknown or deleted thread answers not found", () =>
    Effect.gen(function* () {
      yield* harness.buildAppUnderTest({
        layers: {
          orchestrationEngine: {},
          projectionSnapshotQuery: { getThreadShellById: () => Effect.succeedNone },
        },
      });
      const wsUrl = yield* harness.getWsServerUrl("/ws");
      const error = yield* Effect.scoped(
        harness.withWsRpcClient(wsUrl, (client) =>
          client["githubIssues.syncThreadLinks"]({
            threadId: harness.makeThreadShell().id,
            scope: "all",
          }).pipe(Effect.flip),
        ),
      );
      assert.strictEqual(error._tag, "GitHubIssueOperationError");
      assert.include(error.message, "was not found");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
};
