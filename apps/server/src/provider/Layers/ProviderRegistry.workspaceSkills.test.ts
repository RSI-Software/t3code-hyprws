import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { ProviderRegistryLive } from "./ProviderRegistry.ts";

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest()))(
  "ProviderRegistry workspace skills",
  (it) => {
    it.effect("resolves workspace capabilities through the live provider instance", () =>
      Effect.gen(function* () {
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
        const initialProvider = {
          instanceId: claudeInstanceId,
          driver: claudeDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-08-28T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const observedSkillCwds: string[] = [];
        const observedCommandCwds: string[] = [];
        const workspaceSkill = {
          name: "upstream-triage",
          path: "/workspace/.agents/skills/upstream-triage/SKILL.md",
          enabled: true,
          scope: "project",
        } as const satisfies ServerProviderSkill;
        const workspaceCommand = {
          name: "upstream-triage",
          description: "Triage upstream without posting.",
        } as const satisfies ServerProviderSlashCommand;
        const instance = {
          instanceId: claudeInstanceId,
          driverKind: claudeDriver,
          continuationIdentity: {
            driverKind: claudeDriver,
            continuationKey: "claudeAgent:instance:claudeAgent",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
              provider: claudeDriver,
              packageName: null,
            }),
            getSnapshot: Effect.succeed(initialProvider),
            refresh: Effect.succeed(initialProvider),
            streamChanges: Stream.empty,
          },
          adapter: {} as ProviderInstance["adapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
          discoverSkillsForCwd: (cwd: string) =>
            Effect.sync(() => {
              observedSkillCwds.push(cwd);
              return [workspaceSkill];
            }),
          discoverSlashCommandsForCwd: (cwd: string) =>
            Effect.sync(() => {
              observedCommandCwds.push(cwd);
              return [workspaceCommand];
            }),
        } satisfies ProviderInstance;
        const instanceRegistryLayer = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === claudeInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistryLive.pipe(
            Layer.provideMerge(instanceRegistryLayer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-workspace-capabilities-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          assert.deepStrictEqual(
            yield* registry.discoverSkillsForInstance(claudeInstanceId, "/workspace/repo"),
            [workspaceSkill],
          );
          assert.deepStrictEqual(
            yield* registry.discoverSlashCommandsForInstance(claudeInstanceId, "/workspace/repo"),
            [workspaceCommand],
          );
          assert.deepStrictEqual(observedSkillCwds, ["/workspace/repo"]);
          assert.deepStrictEqual(observedCommandCwds, ["/workspace/repo"]);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );
  },
);
