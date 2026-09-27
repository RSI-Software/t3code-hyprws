import {
  CommandId,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type ThreadCheckoutMoveRequestInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { requestThreadCheckoutMove } from "./checkoutMove.fork.ts";

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const makeSupervisor = Effect.fn("TestCheckoutMoveCommand.makeSupervisor")(function* (
  dispatched: ThreadCheckoutMoveRequestInput[],
) {
  const client = {
    [WS_METHODS.threadCheckoutMoveRequest]: (input: ThreadCheckoutMoveRequestInput) =>
      Effect.sync(() => {
        dispatched.push(input);
        return { requestId: input.requestId, status: "preparing" };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("checkout move command", () => {
  it.effect("mints a request id for a fresh move", () =>
    Effect.gen(function* () {
      const dispatched: ThreadCheckoutMoveRequestInput[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* requestThreadCheckoutMove({
        threadId: ThreadId.make("thread-1"),
        requestedPath: "/workspace/feature",
        expectedCheckoutRoot: "/workspace/main",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          requestId: "00000000-0000-4000-8000-000000000000",
          threadId: "thread-1",
          requestedPath: "/workspace/feature",
          expectedCheckoutRoot: "/workspace/main",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("keeps the caller's request id so a retry replays idempotently", () =>
    Effect.gen(function* () {
      const dispatched: ThreadCheckoutMoveRequestInput[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* requestThreadCheckoutMove({
        requestId: CommandId.make("queued-move"),
        threadId: ThreadId.make("thread-1"),
        requestedPath: "/workspace/feature",
        expectedCheckoutRoot: "/workspace/main",
        reverseOfRequestId: CommandId.make("committed-move"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          requestId: "queued-move",
          threadId: "thread-1",
          requestedPath: "/workspace/feature",
          expectedCheckoutRoot: "/workspace/main",
          reverseOfRequestId: "committed-move",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
});
