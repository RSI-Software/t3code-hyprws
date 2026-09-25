import {
  type ClientOrchestrationCommand,
  EnvironmentHttpApi,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

// Gate: none — client transport for scripts/thread-cli.ts; it drives a server's public RPC surface.

const SOCKET_OPEN_TIMEOUT = "15 seconds";
const REQUEST_TIMEOUT = Duration.seconds(30);

export interface ThreadRpcEndpoint {
  /** HTTP origin of the T3 server, for example `http://127.0.0.1:3773`. */
  readonly httpBaseUrl: string;
  /** Bearer session token from `t3 auth session issue`. Never logged. */
  readonly bearerToken: string;
}

const makeProtocolClient = RpcClient.make(WsRpcGroup);
export type ThreadRpcClient = Effect.Success<typeof makeProtocolClient>;

export class ThreadRpcError extends Schema.TaggedError<ThreadRpcError>()("ThreadRpcError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `no active thread ${this.threadId}`;
  }
}

/** Maps an http(s) origin to its `/ws` endpoint, the path `apps/server/src/ws.ts` routes. */
export function webSocketUrl(httpBaseUrl: string, ticket: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

/**
 * Exchanges the bearer token for a one-use socket ticket, the same route remote clients take in
 * `packages/client-runtime/src/authorization/remote.ts`; the server reads it off the upgrade URL.
 */
const issueWebSocketTicket = (endpoint: ThreadRpcEndpoint) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, {
      baseUrl: endpoint.httpBaseUrl,
    });
    const issued = yield* client.auth.webSocketTicket({
      headers: { authorization: `Bearer ${endpoint.bearerToken}` },
    });
    return issued.ticket;
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.timeout(REQUEST_TIMEOUT));

/** Opens one authenticated RPC socket, runs `use`, and closes the socket with the scope. */
export const withThreadRpcClient = <A, E, R>(
  endpoint: ThreadRpcEndpoint,
  use: (client: ThreadRpcClient) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const ticket = yield* issueWebSocketTicket(endpoint);
    const socketLayer = Socket.layerWebSocket(webSocketUrl(endpoint.httpBaseUrl, ticket), {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
    // One attempt only: a CLI call reports a dead socket instead of reconnecting forever.
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeProtocolClient;
        return yield* use(client);
      }).pipe(Effect.provide(protocolLayer)),
    );
  });

/** First frame of `orchestration.subscribeShell`: active projects and threads. */
export const readShellSnapshot = (client: ThreadRpcClient) =>
  client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new ThreadRpcError({ detail: "shell subscription ended before a snapshot" })),
        onSome: (item): Effect.Effect<OrchestrationShellSnapshot> => Effect.succeed(item.snapshot),
      }),
    ),
    Effect.timeout(REQUEST_TIMEOUT),
  );

export const requireThreadShell = (snapshot: OrchestrationShellSnapshot, threadId: string) => {
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  return thread ? Effect.succeed(thread) : Effect.fail(new ThreadNotFoundError({ threadId }));
};

/** First frame of `orchestration.subscribeThread`: the full thread with its messages. */
export const readThreadDetail = (client: ThreadRpcClient, threadId: ThreadId) =>
  client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId, reasoningMessages: true }).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new ThreadNotFoundError({ threadId })),
        onSome: (item): Effect.Effect<OrchestrationThread> => Effect.succeed(item.snapshot.thread),
      }),
    ),
    Effect.timeout(REQUEST_TIMEOUT),
  );

export const dispatchCommand = (client: ThreadRpcClient, command: ClientOrchestrationCommand) =>
  client[ORCHESTRATION_WS_METHODS.dispatchCommand](command).pipe(Effect.timeout(REQUEST_TIMEOUT));

/**
 * Follows the live shell stream until `settled` holds for the thread, or the timeout passes.
 * Resolves the last observed shell, or `undefined` when the thread was never seen.
 */
export const waitForThreadShell = (
  client: ThreadRpcClient,
  threadId: string,
  settled: (thread: OrchestrationThreadShell) => boolean,
  timeout: Duration.Duration,
) =>
  Effect.gen(function* () {
    let latest: OrchestrationThreadShell | undefined;
    const done = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
      Stream.map((item): OrchestrationThreadShell | undefined => {
        if (item.kind === "snapshot") {
          return item.snapshot.threads.find((candidate) => candidate.id === threadId);
        }
        return item.kind === "thread-upserted" && item.thread.id === threadId
          ? item.thread
          : undefined;
      }),
      Stream.filter((thread) => thread !== undefined),
      Stream.tap((thread) =>
        Effect.sync(() => {
          latest = thread;
        }),
      ),
      Stream.filter(settled),
      Stream.runHead,
      Effect.timeoutOption(timeout),
    );
    return { settled: Option.isSome(Option.flatten(done)), latest };
  });
