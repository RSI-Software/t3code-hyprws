// Fork-only (colleague-collab): a collaborator's sessions keep access with no time limit.
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const layerServerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return { ...config, mode: "web" as const, host: "192.168.1.50" };
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-fork-test-" })));

const layer = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerServerConfig),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
);

const requestMetadata = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };

it.effect("keeps a collaborator's browser and desktop sessions past 30 days", () =>
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const key = makeDpopKey();
    const link = () =>
      serverAuth
        .createPairingLink({ subject: "colleague:sam", scopes: ["orchestration:read"] })
        .pipe(Effect.map((issued) => issued.credential));
    const browser = yield* serverAuth.createBrowserSession(yield* link(), requestMetadata);
    const desktop = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
      yield* link(),
      undefined,
      requestMetadata,
      { proofKeyThumbprint: key.thumbprint },
    );

    yield* TestClock.adjust("400 days");
    yield* sessions.verify(browser.sessionToken);
    yield* serverAuth.renewAccessToken(desktop.access_token, key.thumbprint, Effect.void);
  }).pipe(Effect.provide(layer)),
);
