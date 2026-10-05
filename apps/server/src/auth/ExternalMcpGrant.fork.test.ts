import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { externalMcpPolicyFromFlags } from "../cli/authDevice.fork.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as DeviceAuthorization from "./DeviceAuthorization.fork.ts";
import * as ExternalMcpGrant from "./ExternalMcpGrant.fork.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const storeLayer = Layer.mergeAll(DeviceAuthorization.layer, ExternalMcpGrant.layer).pipe(
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(Layer.mergeAll(SqlitePersistenceMemory, ServerSecretStore.layer)),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("external-mcp-grant-test")),
    }),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-external-mcp-test-" })),
);

const client = { label: "dot cloud", deviceType: "bot" } as const;
const policy: ExternalMcpGrant.ExternalMcpPolicy = {
  projectIds: [ProjectId.make("project:granted")],
  coordinate: true,
  maxRuntimeMode: "approval-required",
  maxInteractionMode: "plan",
};

it.layer(NodeServices.layer)("external MCP device grants", (it) => {
  it.effect("issues a scopeless session whose only authority is the policy", () =>
    Effect.gen(function* () {
      const store = yield* DeviceAuthorization.DeviceAuthorizationStore;
      const grants = yield* ExternalMcpGrant.ExternalMcpGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const started = Option.getOrThrow(
        yield* store.start({
          client,
          requestedScopes: ["orchestration:read"],
          proofKeyThumbprint: "client-key",
        }),
      );
      const approved = Option.getOrThrow(
        yield* store.approve({ userCode: started.userCode, mcpPolicy: policy }),
      );
      expect(approved).toMatchObject({ scopes: [], mcpPolicy: policy });

      const issued = yield* store.poll({
        deviceCode: started.deviceCode,
        proof: { thumbprint: "client-key", issuedAt: 1 },
      });
      if (issued._tag !== "Issued") throw new Error(`expected Issued, got ${issued._tag}`);
      const verified = yield* sessions.verify(issued.session.token);
      expect(verified.scopes).toEqual([]);
      expect(yield* grants.getBySession(verified.sessionId)).toEqual(
        Option.some({ policy, clientLabel: "dot cloud" }),
      );
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("leaves an ordinary device grant without an MCP grant", () =>
    Effect.gen(function* () {
      const store = yield* DeviceAuthorization.DeviceAuthorizationStore;
      const grants = yield* ExternalMcpGrant.ExternalMcpGrantStore;
      const started = Option.getOrThrow(
        yield* store.start({ client, proofKeyThumbprint: "client-key" }),
      );
      yield* store.approve({ userCode: started.userCode });
      const issued = yield* store.poll({
        deviceCode: started.deviceCode,
        proof: { thumbprint: "client-key", issuedAt: 1 },
      });
      if (issued._tag !== "Issued") throw new Error(`expected Issued, got ${issued._tag}`);
      expect(Option.isNone(yield* grants.getBySession(issued.session.sessionId))).toBe(true);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("refuses a policy on a bearer request or beside scopes", () =>
    Effect.gen(function* () {
      const store = yield* DeviceAuthorization.DeviceAuthorizationStore;
      const bearer = Option.getOrThrow(yield* store.start({ client }));
      const unbound = yield* store
        .approve({ userCode: bearer.userCode, mcpPolicy: policy })
        .pipe(Effect.flip);
      expect(unbound).toMatchObject({ reason: "unbound-request" });

      const bound = Option.getOrThrow(
        yield* store.start({ client, proofKeyThumbprint: "client-key" }),
      );
      const scoped = yield* store
        .approve({ userCode: bound.userCode, mcpPolicy: policy, scopes: ["orchestration:read"] })
        .pipe(Effect.flip);
      expect(scoped).toMatchObject({ reason: "scopes-with-policy" });
      // Neither refusal decided the request.
      expect(yield* store.listOpen()).toHaveLength(2);
    }).pipe(Effect.provide(storeLayer)),
  );
});

it("reads the approve flags into a policy with conservative ceilings", () => {
  const none = {
    mcpProject: [],
    mcpAllProjects: false,
    mcpCoordinate: false,
    mcpMaxRuntimeMode: Option.none(),
    mcpMaxInteractionMode: Option.none(),
    scope: Option.none(),
  } as const;
  expect(externalMcpPolicyFromFlags(none)).toBeUndefined();
  expect(externalMcpPolicyFromFlags({ ...none, mcpProject: ["a", "b"] })).toEqual({
    projectIds: ["a", "b"],
    coordinate: false,
    maxRuntimeMode: "approval-required",
    maxInteractionMode: "plan",
  });
  expect(
    externalMcpPolicyFromFlags({
      ...none,
      mcpAllProjects: true,
      mcpCoordinate: true,
      mcpMaxRuntimeMode: Option.some("full-access"),
      mcpMaxInteractionMode: Option.some("default"),
    }),
  ).toEqual({
    projectIds: "*",
    coordinate: true,
    maxRuntimeMode: "full-access",
    maxInteractionMode: "default",
  });
  // A coordinate flag alone names no project, and a policy never carries scopes.
  expect(typeof externalMcpPolicyFromFlags({ ...none, mcpCoordinate: true })).toBe("string");
  expect(
    typeof externalMcpPolicyFromFlags({ ...none, mcpProject: ["a"], mcpAllProjects: true }),
  ).toBe("string");
  expect(
    typeof externalMcpPolicyFromFlags({
      ...none,
      mcpProject: ["a"],
      scope: Option.some("orchestration:read"),
    }),
  ).toBe("string");
});
