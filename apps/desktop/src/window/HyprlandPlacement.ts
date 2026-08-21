/**
 * Remembers which Hyprland client belongs to which desktop window, so the
 * workspace a window sits on survives an update relaunch.
 *
 * This is deliberately not a placement policy. Hyprland still decides where a
 * window opens; the only move this service ever makes is putting a restored
 * window back where the user had already dragged it, and it makes that move
 * silently so the user's current workspace never changes underneath them.
 *
 * Every operation is best-effort. Off Hyprland, or with the socket gone, each
 * one becomes a no-op instead of an error -- window restore must not depend on
 * a compositor being present.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import {
  formatWorkspaceArgument,
  parseHyprlandClients,
  readHyprlandSocketEnvironment,
  requestHyprland,
  selectClientForWindow,
  type HyprlandSocketEnvironment,
  type HyprlandWorkspaceRef,
} from "./hyprland.ts";

const { logDebug: logPlacementDebug } = makeComponentLogger("desktop.hyprland");

// A window is mapped a beat after Electron shows it. Poll briefly rather than
// racing the compositor; giving up just means this window has no remembered
// workspace, which is the pre-fork behavior.
const CLAIM_ATTEMPTS = 20;
const CLAIM_INTERVAL_MS = 100;

export class HyprlandPlacement extends Context.Service<
  HyprlandPlacement,
  {
    readonly isAvailable: boolean;
    /**
     * Binds a window key to the compositor client that just appeared for it.
     * Safe to call for every window; keys that never match stay unbound.
     */
    readonly claim: (key: string, title: string) => Effect.Effect<void>;
    readonly forget: (key: string) => Effect.Effect<void>;
    readonly workspaceOf: (key: string) => Effect.Effect<Option.Option<HyprlandWorkspaceRef>>;
    /** Moves a claimed window to `workspace` without switching the view. */
    readonly moveToWorkspace: (key: string, workspace: HyprlandWorkspaceRef) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/HyprlandPlacement") {}

export const make = (options: {
  readonly environment: HyprlandSocketEnvironment;
  readonly pid: number;
  readonly claimAttempts?: number;
  readonly claimIntervalMs?: number;
}) =>
  Effect.sync(() => {
    const addressesByKey = new Map<string, string>();
    const isAvailable = (options.environment.instanceSignature?.trim() ?? "").length > 0;
    const claimAttempts = options.claimAttempts ?? CLAIM_ATTEMPTS;
    const claimIntervalMs = options.claimIntervalMs ?? CLAIM_INTERVAL_MS;

    const request = (payload: string) =>
      Effect.tryPromise(() => requestHyprland(options.environment, payload)).pipe(Effect.option);

    const readClients = request("j/clients").pipe(
      Effect.map((payload) => (Option.isSome(payload) ? parseHyprlandClients(payload.value) : [])),
    );

    const claim = Effect.fn("desktop.hyprland.claim")(function* (key: string, title: string) {
      if (!isAvailable || addressesByKey.has(key)) return;
      for (let attempt = 0; attempt < claimAttempts; attempt += 1) {
        const clients = yield* readClients;
        const client = selectClientForWindow({
          clients,
          pid: options.pid,
          title,
          claimedAddresses: new Set(addressesByKey.values()),
        });
        if (client !== null) {
          addressesByKey.set(key, client.address);
          yield* logPlacementDebug("window claimed", {
            key,
            address: client.address,
            workspace: client.workspace.name,
          });
          return;
        }
        yield* Effect.sleep(`${claimIntervalMs} millis`);
      }
      yield* logPlacementDebug("window never matched a compositor client", { key, title });
    });

    const workspaceOf = Effect.fn("desktop.hyprland.workspaceOf")(function* (key: string) {
      const address = addressesByKey.get(key);
      if (!isAvailable || address === undefined) {
        return Option.none<HyprlandWorkspaceRef>();
      }
      const clients = yield* readClients;
      const client = clients.find((candidate) => candidate.address === address);
      return client === undefined
        ? Option.none<HyprlandWorkspaceRef>()
        : Option.some(client.workspace);
    });

    const moveToWorkspace = Effect.fn("desktop.hyprland.moveToWorkspace")(function* (
      key: string,
      workspace: HyprlandWorkspaceRef,
    ) {
      const address = addressesByKey.get(key);
      if (!isAvailable || address === undefined) return;
      const target = formatWorkspaceArgument(workspace);
      yield* request(`/dispatch movetoworkspacesilent ${target},address:${address}`);
      yield* logPlacementDebug("window returned to workspace", { key, workspace: target });
    });

    return HyprlandPlacement.of({
      isAvailable,
      claim,
      forget: (key) => Effect.sync(() => void addressesByKey.delete(key)),
      workspaceOf,
      moveToWorkspace,
    });
  });

export const layer = Layer.effect(
  HyprlandPlacement,
  Effect.suspend(() => make({ environment: readHyprlandSocketEnvironment(), pid: process.pid })),
);
