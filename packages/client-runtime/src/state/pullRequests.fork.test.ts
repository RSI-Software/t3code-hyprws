import { EnvironmentId, ProjectId, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { RpcClientError } from "effect/rpc";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { PreparedConnection, SupervisorConnectionState } from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import { createPullRequestEnvironmentAtoms } from "./pullRequests.ts";

it.effect.each(["current", "unknown RPC", "missing method"] as const)(
  "isolates activity from turns and preserves reads on a %s server",
  (server) =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const turns = yield* SubscriptionRef.make(0);
        const edits = yield* SubscriptionRef.make(0);
        let reads = 0;
        let detailReads = 0;
        let detailRefreshed = Latch.makeUnsafe();
        const activityRead = Latch.makeUnsafe();
        const client = {
          [WS_METHODS.pullRequestsSubscribeRefreshes]: () =>
            SubscriptionRef.changes(turns).pipe(Stream.filter((revision) => revision > 0)),
          ...(server === "missing method"
            ? {}
            : {
                [WS_METHODS.pullRequestsSubscribeActivityRefreshesFork]: () =>
                  server === "unknown RPC"
                    ? Stream.fail(
                        new RpcClientError.RpcClientError({
                          reason: new RpcClientError.RpcClientDefect({
                            message:
                              "Unknown request tag: pullRequests.subscribeActivityRefreshesFork",
                            cause: new Error("Unknown request tag"),
                          }),
                        }),
                      )
                    : SubscriptionRef.changes(edits).pipe(
                        Stream.filter((revision) => revision > 0),
                      ),
              }),
          [WS_METHODS.pullRequestsActivity]: () =>
            Effect.sync(() => {
              reads++;
              if (reads === 2) activityRead.openUnsafe();
              return {
                author: null,
                reviewers: [],
                comments: [],
                commentCount: reads,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
                reactions: [],
              };
            }),
          [WS_METHODS.pullRequestsDetail]: () =>
            Effect.sync(() => {
              detailReads++;
              if (detailReads > 1) detailRefreshed.openUnsafe();
              return { state: "open" };
            }),
        } as unknown as WsRpcProtocolClient;
        const target = new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("environment-1"),
          label: "Test",
          httpBaseUrl: "https://example.test",
          wsBaseUrl: "wss://example.test",
        });
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            network: "online",
            phase: "connected",
            attempt: 1,
            generation: 1,
          }),
          session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
            Option.some({
              client,
              ready: Effect.void,
              probe: Effect.void,
              closed: Effect.never,
              initialConfig: Effect.never,
              subscribeServerConfig: () => Stream.empty,
            } satisfies RpcSession),
          ),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const registryService = EnvironmentRegistry.EnvironmentRegistry.of({
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map([[target.environmentId, { target, profile: Option.none(), enabled: true }]]),
          ),
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          runStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.mergeAll(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService),
            Layer.mock(PullRequestDiffLoader.PullRequestDiffLoader)({
              load: () => Effect.die("unused"),
            }),
          ),
        );
        const atoms = createPullRequestEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
          Effect.sync(() => value.dispose()),
        );
        const ref = {
          environmentId: target.environmentId,
          input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
        };
        const activity = atoms.activity(ref);
        const detail = atoms.detail(ref);
        let unmountActivity = registry.mount(activity);
        yield* Effect.addFinalizer(() => Effect.sync(() => unmountActivity()));
        const unmountDetail = registry.mount(detail);
        yield* Effect.addFinalizer(() => Effect.sync(unmountDetail));
        yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
        expect(reads).toBe(1);

        // Older than the server activity TTL: a turn must still cause no activity RPC.
        vi.advanceTimersByTime(61_000);
        yield* TestClock.adjust("61 seconds");
        for (let turn = 1; turn <= 3; turn++) {
          detailRefreshed = Latch.makeUnsafe();
          yield* SubscriptionRef.set(turns, turn);
          yield* detailRefreshed.await;
          expect(reads).toBe(1);
        }
        if (server === "current") yield* SubscriptionRef.set(edits, 1);
        else registry.refresh(activity); // Missing notifications never prevent explicit reads.
        yield* activityRead.await;
        yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
        expect(reads).toBe(2);

        unmountActivity();
        yield* Effect.yieldNow;
        vi.advanceTimersByTime(6 * 60_000);
        yield* TestClock.adjust("6 minutes");
        unmountActivity = registry.mount(activity);
        yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
        expect(reads).toBe(3);
      }),
    ),
);
