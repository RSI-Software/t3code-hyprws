// Fork-only (colleague-collab): a collaborator's sessions keep access with no time limit, and
// reach no HTTP beyond the socket and their shared threads.
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthStandardClientScopes,
  COLLABORATOR_SCOPES,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as DeviceHubProxy from "../device/DeviceHubProxy.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as SpeechService from "../speech/SpeechService.ts";
import { speechStreamRouteLayer } from "../speech/stream.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectHttp from "../project/http.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import { isCollaboratorHttpRefusedFork } from "../collaborator/collaboratorSubject.fork.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as AuthHttp from "./http.ts";
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

class CollaboratorHttpTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.projects) {}

const stub = <I, S>(tag: Context.Key<I, S>, service: object) => Context.make(tag, service as never);

it.effect("refuses a collaborator every HTTP and media route but its socket", () =>
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const bearer = (subject: string | undefined, scopes: ReadonlyArray<string>) =>
      serverAuth
        .createPairingLink({ ...(subject ? { subject } : {}), scopes: scopes as never })
        .pipe(
          Effect.flatMap((link) =>
            serverAuth.exchangeBootstrapCredentialForAccessToken(
              link.credential,
              undefined,
              requestMetadata,
            ),
          ),
          Effect.map((token) => `Bearer ${token.access_token}`),
        );
    const host = yield* bearer(undefined, AuthStandardClientScopes);
    const sam = yield* bearer("colleague:sam", COLLABORATOR_SCOPES);

    const now = "2026-11-25T00:00:00.000Z";
    const project = {
      id: "private-project",
      title: "Private",
      workspaceRoot: "/home/host/private",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    // Fakes for the host services behind the routes under test.
    const hostServices = Context.mergeAll(
      stub(ProjectService.ProjectService, {
        snapshot: Effect.succeed({ projects: [project], updatedAt: now }),
      }),
      stub(ProjectCloneTracker.ProjectCloneTracker, {}),
      stub(ServerRuntimeStartup.ServerRuntimeStartup, {}),
      stub(DeviceService.DeviceService, { currentReadiness: () => Effect.succeed(null) }),
      stub(SpeechService.SpeechService, {}),
      stub(HttpClient.HttpClient, {}),
      stub(Socket.WebSocketConstructor, {}),
      stub(ServerSecretStore.ServerSecretStore, {}),
    );
    const api = HttpApiBuilder.layer(CollaboratorHttpTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(ProjectHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    );
    const routes = Layer.mergeAll(api, DeviceHubProxy.layer, speechStreamRouteLayer).pipe(
      // The same auth, sessions, and database the bearers were issued from.
      Layer.provide(
        Layer.succeedContext(
          yield* Effect.context<EnvironmentAuth.EnvironmentAuth | SessionStore.SessionStore>(),
        ),
      ),
      Layer.provide(Layer.succeedContext(hostServices)),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    );
    // Bare router handlers read services per request: the test's clock and sessions, and the fakes.
    const requestContext = Context.merge(
      yield* Effect.context<
        SecureRandom.SecureRandom | SessionStore.SessionStore | EnvironmentAuth.EnvironmentAuth
      >(),
      hostServices,
    );
    const status = (authorization: string, method: string, path: string) =>
      Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        ({ handler }) =>
          Effect.promise(() =>
            handler(
              new Request(`http://127.0.0.1${path}`, { method, headers: { authorization } }),
              requestContext,
            ).then((response) => response.status),
          ),
        ({ dispose }) => Effect.promise(dispose),
      );

    // One allowed endpoint, one refused endpoint, the shared media helper, and the voice socket.
    assert.deepStrictEqual(
      {
        hostProjects: yield* status(host, "GET", "/api/projects"),
        samTicket: yield* status(sam, "POST", "/api/auth/websocket-ticket"),
        samProjects: yield* status(sam, "GET", "/api/projects"),
        samDeviceHub: yield* status(sam, "GET", "/api/device-hub/api/devices"),
        samVoiceSocket: yield* status(sam, "GET", "/ws/voice"),
      },
      {
        hostProjects: 200,
        samTicket: 200,
        samProjects: 403,
        samDeviceHub: 403,
        samVoiceSocket: 403,
      },
    );

    // Pinned against the real API, so a moved endpoint cannot silently drop out.
    const open = Object.values(EnvironmentHttpApi.groups).flatMap((group) =>
      Object.entries(group.endpoints)
        .filter(([, { path }]) => {
          const url = path.replaceAll(/:[A-Za-z]+/g, "x");
          return !isCollaboratorHttpRefusedFork("colleague:sam", url);
        })
        .map(([name]) => `${group.identifier}.${name}`),
    );
    assert.deepStrictEqual(open, [
      "auth.webSocketTicket",
      "auth.webSocketTicketFor",
      "orchestration.threadSnapshot",
      "orchestration.threadTranscript",
      "orchestration.threadBoundedSnapshot",
      "orchestration.threadHistoryPage",
    ]);
  }).pipe(Effect.provide(layer)),
);
