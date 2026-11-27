import { assert, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  RpcScopeAuthorization,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

import * as CollaboratorShares from "./CollaboratorShares.fork.ts";
import {
  type Ingress,
  database,
  shared,
  withService,
} from "./CollaboratorShares.fork.testFixtures.ts";

it.effect("hands out the collaborator grant only to a session holding it", () =>
  Effect.gen(function* () {
    const denied = (scopes: ReadonlyArray<AuthEnvironmentScope>, method: string) =>
      Effect.service(RpcScopeAuthorization).pipe(
        Effect.flatMap((authorize) =>
          authorize(
            Effect.void as never,
            {
              rpc: { _tag: method },
              payload: { threadId: shared, collaboratorName: "Sam", access: "send" },
            } as never,
          ),
        ),
        Effect.provide(RpcAuthorization.layer(scopes)),
        Effect.flip,
        Effect.map(
          (error) => (error as { requiredPermission: AuthEnvironmentScope }).requiredPermission,
        ),
        Effect.orElseSucceed(() => null),
      );
    const manager = [AuthAccessWriteScope];
    const reader = [AuthAccessWriteScope, AuthOrchestrationReadScope];
    const host = [...reader, AuthOrchestrationOperateScope];
    const share = WS_METHODS.collaboratorShareThreadFork;
    const setAccess = WS_METHODS.collaboratorSetAccessFork;
    assert.strictEqual(yield* denied(manager, share), AuthOrchestrationReadScope);
    assert.strictEqual(yield* denied(reader, share), AuthOrchestrationOperateScope);
    assert.strictEqual(yield* denied(reader, setAccess), AuthOrchestrationOperateScope);
    assert.isNull(yield* denied(host, share));
    assert.strictEqual(
      yield* denied(manager, WS_METHODS.colleagueInviteFork),
      AuthOrchestrationReadScope,
    );
    assert.strictEqual(
      yield* denied(reader, WS_METHODS.colleagueShareThreadFork),
      AuthOrchestrationOperateScope,
    );
    assert.isNull(yield* denied(host, WS_METHODS.colleagueInviteFork));
    assert.isNull(yield* denied(manager, WS_METHODS.collaboratorUnshareThreadFork));
  }),
);

database("CollaboratorSharesFork", (it) => {
  it.effect("bases the link on the local tunnel, then the sharing client's public origin", () =>
    Effect.gen(function* () {
      const link = (linkBaseUrl: string, tunnel?: Ingress) =>
        withService(
          Effect.gen(function* () {
            const service = yield* CollaboratorShares.CollaboratorSharesFork;
            const { pairingUrl, localOnly } = yield* service.share({
              threadId: shared,
              collaboratorName: "Sam",
              linkBaseUrl,
            });
            return { origin: new URL(pairingUrl).origin, localOnly };
          }),
          tunnel,
        );
      assert.deepStrictEqual(
        yield* link("http://127.0.0.1:3773", [
          { hostname: "api.example.com", path: "^/api", service: "http://localhost:3773" },
          { hostname: "other.example.com", service: "http://localhost:4000" },
          { hostname: "other.example.com", service: "http://localhost:3773" },
          { hostname: "pair.example.com", path: "^/pair", service: "http://localhost:4000" },
          { hostname: "pair.example.com", service: "http://localhost:3773" },
          { hostname: "t3.example.com", service: "http://localhost:3773" },
          { service: "http_status:503" },
        ]),
        { origin: "https://t3.example.com", localOnly: false },
      );
      assert.deepStrictEqual(yield* link("https://app.example.com/x"), {
        origin: "https://app.example.com",
        localOnly: false,
      });
      for (const local of ["http://localhost:9999", "http://[fd00::1]:3773", "http://box.local"]) {
        assert.isTrue((yield* link(local)).localOnly, local);
      }
      assert.isTrue(
        (yield* link("http://localhost:9999", [
          { hostname: "*.example.com", service: "http://localhost:3773" },
        ])).localOnly,
      );
      assert.isTrue(
        (yield* link("http://localhost:9999", [
          { hostname: "*", path: "^/pair", service: "http://localhost:4000" },
          { hostname: "t3.example.com", service: "http://localhost:3773" },
        ])).localOnly,
      );
    }),
  );
});
