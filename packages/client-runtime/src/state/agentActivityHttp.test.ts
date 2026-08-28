import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchEnvironmentAgentActivity } from "./agentActivityHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const RESPONSE = {
  agentId: "agent-1",
  activities: [],
  page: {
    beforeCursor: "next-page",
    hasMore: true,
    snapshotSequence: 12,
    threadSequence: 8,
  },
};

describe("fetchEnvironmentAgentActivity", () => {
  it.effect("gets a cursor page with local session credentials", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(Response.json(RESPONSE));
      }) satisfies typeof fetch;

      const result = yield* fetchEnvironmentAgentActivity({
        prepared: PREPARED,
        signer: Option.none(),
        request: {
          threadId: ThreadId.make("thread-1"),
          agentId: "agent-1",
          limit: 25,
          beforeCursor: "cursor page/2",
        },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(result).toEqual(RESPONSE);
      expect(calls).toHaveLength(1);
      const [request, init] = calls[0]!;
      const url = new URL(String(request));
      expect(url.pathname).toBe("/api/orchestration/threads/thread-1/agents/agent-1/activities");
      expect([...url.searchParams]).toEqual([
        ["limit", "25"],
        ["beforeCursor", "cursor page/2"],
      ]);
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("include");
    }),
  );

  it.effect("sends bearer authorization without cookie credentials", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(Response.json(RESPONSE));
      }) satisfies typeof fetch;

      yield* fetchEnvironmentAgentActivity({
        prepared: {
          ...PREPARED,
          httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
        },
        signer: Option.none(),
        request: {
          threadId: ThreadId.make("thread-1"),
          agentId: "agent-1",
          limit: 50,
        },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      const [, init] = calls[0]!;
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer bearer-token");
      expect(init.credentials).toBeUndefined();
    }),
  );

  it.effect("signs the exact paginated URL for DPoP authorization", () =>
    Effect.gen(function* () {
      const proofInputs: Array<ManagedRelayDpopProofInput> = [];
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("thumbprint"),
        createProof: (input) => {
          proofInputs.push(input);
          return Effect.succeed("signed-proof");
        },
      });
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(Response.json(RESPONSE));
      }) satisfies typeof fetch;

      yield* fetchEnvironmentAgentActivity({
        prepared: {
          ...PREPARED,
          httpAuthorization: { _tag: "Dpop", accessToken: "dpop-token" },
        },
        signer: Option.some(signer),
        request: {
          threadId: ThreadId.make("thread-1"),
          agentId: "agent-1",
          limit: 50,
          beforeCursor: "signed cursor",
        },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      const [request, init] = calls[0]!;
      expect(proofInputs).toEqual([
        {
          method: "GET",
          url: String(request),
          accessToken: "dpop-token",
        },
      ]);
      expect(new Headers(init.headers).get("authorization")).toBe("DPoP dpop-token");
      expect(new Headers(init.headers).get("dpop")).toBe("signed-proof");
      expect(new URL(String(request)).searchParams.get("beforeCursor")).toBe("signed cursor");
      expect(init.credentials).toBeUndefined();
    }),
  );
});
