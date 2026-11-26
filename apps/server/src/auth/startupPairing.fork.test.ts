import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Keybindings from "../keybindings.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRuntimeRecovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

// The whole startup, so a sync that moves the startup link away from the hook fails here.
const boot = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const minted: string[] = [];
    const settled = yield* Deferred.make<"minted" | "skipped">();
    const recovery = {
      terminalizedRuns: 0,
      stoppedSessions: 0,
      closedRequests: 0,
      retiredEffects: 0,
      requeuedEffects: 0,
    };
    const imports = { importedThreadCount: 0, importedMessageCount: 0 };
    const dependencies = Layer.mergeAll(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-startup-pairing-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      NodeServices.layer,
      NodeCrypto.layer,
      Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
      Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
        pendingThreadCount: Effect.succeed(0),
        reconcileShells: Effect.succeed(imports),
        importPendingTranscripts: Effect.succeed(imports),
      }),
      Layer.mock(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)({
        recover: Effect.succeed(recovery),
        prepareForShutdown: Effect.void,
        reconcile: () => Effect.succeed(recovery),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({ recoverDelegatedTasks: Effect.void }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ shutdown: Effect.void }),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ start: () => Effect.void }),
      Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: () => Effect.never }),
      Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
        publish: (event) => Effect.succeed({ ...event, sequence: 1 }),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        start: Effect.void,
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("startup-pairing"),
          label: "Test environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({ shouldRunHostWork: Effect.succeed(true) }),
      Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
      }),
      Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
        managed: false,
        protocol: undefined,
        prepareTrial: () => Effect.undefined,
      }),
      Layer.mock(AnalyticsService.AnalyticsService)({}),
      Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        issueStartupPairingUrl: (baseUrl) =>
          Effect.sync(() => minted.push(baseUrl)).pipe(
            Effect.andThen(Deferred.succeed(settled, "minted")),
            Effect.as(`${baseUrl}/pair#token=test`),
          ),
      }),
      Layer.mock(ExternalLauncher.ExternalLauncher)({ launchBrowser: () => Effect.void }),
      ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
      Logger.layer([
        Logger.make(({ message }) => {
          if (String(message).includes("Startup pairing link skipped")) {
            Deferred.doneUnsafe(settled, Effect.succeed("skipped"));
          }
        }),
      ]),
    );
    const outcome = yield* Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      yield* startup.markHttpListening;
      yield* startup.awaitCommandReady;
      return yield* Deferred.await(settled);
    }).pipe(
      Effect.provide(ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(dependencies))),
    );
    return { outcome, minted };
  });

it.effect("T3CODE_NO_STARTUP_PAIRING mints no startup pairing link", () =>
  Effect.gen(function* () {
    const { outcome, minted } = yield* boot({ T3CODE_NO_STARTUP_PAIRING: "1" });
    assert.equal(outcome, "skipped");
    assert.deepStrictEqual(minted, []);
  }),
);

it.effect("without the switch, startup mints its pairing link", () =>
  Effect.gen(function* () {
    const { outcome, minted } = yield* boot({});
    assert.equal(outcome, "minted");
    assert.equal(minted.length, 1);
  }),
);
