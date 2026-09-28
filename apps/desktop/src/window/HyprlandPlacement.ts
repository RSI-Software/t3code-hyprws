/**
 * Remembers which Hyprland client belongs to which desktop window. Update
 * relaunches restore a previous arrangement; dev:desktop:agent may stage one
 * explicit map-time target chosen from the invoking app's workspace.
 *
 * This is deliberately not monitor policy. The service never derives where a
 * window belongs and every move is silent, so the user's current workspace does
 * not change underneath them.
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
  formatClearWorkspaceWindowRule,
  formatMoveToWorkspaceRequest,
  formatSuppressActivationWindowRule,
  formatWorkspaceArgument,
  formatWorkspaceWindowRule,
  parseHyprlandClients,
  readHyprlandSocketEnvironment,
  requestHyprland,
  resolveHyprlandWindowRuleGrammar,
  selectClientForWindow,
  type HyprlandSocketEnvironment,
  type HyprlandWindowRuleGrammar,
  type HyprlandWorkspaceRef,
} from "./hyprland.ts";
import type { WindowId } from "./WindowId.fork.ts";

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
     * Binds a window to the compositor client that just appeared for it.
     * Safe to call for every window; windows that never match stay unbound.
     */
    readonly claim: (windowId: WindowId, title: string) => Effect.Effect<void>;
    readonly forget: (windowId: WindowId) => Effect.Effect<void>;
    readonly workspaceOf: (
      windowId: WindowId,
    ) => Effect.Effect<Option.Option<HyprlandWorkspaceRef>>;
    /** Stages a title-scoped rule before a hidden window maps. */
    readonly stageWorkspaceRule: (
      title: string,
      workspace: HyprlandWorkspaceRef,
    ) => Effect.Effect<boolean>;
    readonly clearWorkspaceRule: (title: string) => Effect.Effect<void>;
    /** Moves a claimed window to `workspace` without switching the view. */
    readonly moveToWorkspace: (
      windowId: WindowId,
      workspace: HyprlandWorkspaceRef,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/HyprlandPlacement") {}

const make = (options: {
  readonly environment: HyprlandSocketEnvironment;
  readonly pid: number;
  readonly claimAttempts?: number;
  readonly claimIntervalMs?: number;
}) =>
  Effect.sync(() => {
    const addressesByWindowId = new Map<WindowId, string>();
    const isAvailable = (options.environment.instanceSignature?.trim() ?? "").length > 0;
    const claimAttempts = options.claimAttempts ?? CLAIM_ATTEMPTS;
    const claimIntervalMs = options.claimIntervalMs ?? CLAIM_INTERVAL_MS;
    let windowRuleGrammar: HyprlandWindowRuleGrammar | undefined;

    const request = (payload: string) =>
      Effect.tryPromise(() => requestHyprland(options.environment, payload)).pipe(Effect.option);

    const readClients = request("j/clients").pipe(
      Effect.map((payload) => (Option.isSome(payload) ? parseHyprlandClients(payload.value) : [])),
    );

    const resolveWindowRuleGrammar = Effect.fn("desktop.hyprland.windowRuleGrammar")(function* () {
      if (windowRuleGrammar !== undefined) return windowRuleGrammar;
      const version = yield* request("j/version");
      const status = yield* request("j/status");
      windowRuleGrammar =
        Option.isSome(version) && Option.isSome(status)
          ? resolveHyprlandWindowRuleGrammar({
              versionPayload: version.value,
              statusPayload: status.value,
            })
          : "legacy";
      return windowRuleGrammar;
    });

    const claim = Effect.fn("desktop.hyprland.claim")(function* (
      windowId: WindowId,
      title: string,
    ) {
      if (!isAvailable || addressesByWindowId.has(windowId)) return;
      for (let attempt = 0; attempt < claimAttempts; attempt += 1) {
        const clients = yield* readClients;
        const client = selectClientForWindow({
          clients,
          pid: options.pid,
          title,
          claimedAddresses: new Set(addressesByWindowId.values()),
        });
        if (client !== null) {
          addressesByWindowId.set(windowId, client.address);
          yield* logPlacementDebug("window claimed", {
            windowId,
            address: client.address,
            workspace: client.workspace.name,
          });
          return;
        }
        yield* Effect.sleep(`${claimIntervalMs} millis`);
      }
      yield* logPlacementDebug("window never matched a compositor client", { windowId, title });
    });

    const workspaceOf = Effect.fn("desktop.hyprland.workspaceOf")(function* (windowId: WindowId) {
      const address = addressesByWindowId.get(windowId);
      if (!isAvailable || address === undefined) {
        return Option.none<HyprlandWorkspaceRef>();
      }
      const clients = yield* readClients;
      const client = clients.find((candidate) => candidate.address === address);
      return client === undefined
        ? Option.none<HyprlandWorkspaceRef>()
        : Option.some(client.workspace);
    });

    const stageWorkspaceRule = Effect.fn("desktop.hyprland.stageWorkspaceRule")(function* (
      title: string,
      workspace: HyprlandWorkspaceRef,
    ) {
      if (!isAvailable) return false;
      const grammar = yield* resolveWindowRuleGrammar();
      const workspacePayload = formatWorkspaceWindowRule(workspace, title, grammar);
      const suppressionPayload = formatSuppressActivationWindowRule(title, grammar);
      if (workspacePayload === null || suppressionPayload === null) return false;
      // The exact worktree title keeps the activation guard safe to retain,
      // which also covers every Electron restart owned by the development watcher.
      const workspaceResult = yield* request(workspacePayload);
      const suppressionResult = yield* request(suppressionPayload);
      return Option.isSome(workspaceResult) && Option.isSome(suppressionResult);
    });

    const clearWorkspaceRule = Effect.fn("desktop.hyprland.clearWorkspaceRule")(function* (
      title: string,
    ) {
      if (!isAvailable) return;
      const grammar = yield* resolveWindowRuleGrammar();
      const payload = formatClearWorkspaceWindowRule(title, grammar);
      if (payload !== null) yield* request(payload);
    });

    const moveToWorkspace = Effect.fn("desktop.hyprland.moveToWorkspace")(function* (
      windowId: WindowId,
      workspace: HyprlandWorkspaceRef,
    ) {
      const address = addressesByWindowId.get(windowId);
      if (!isAvailable || address === undefined) return;
      const grammar = yield* resolveWindowRuleGrammar();
      const target = formatWorkspaceArgument(workspace);
      yield* request(formatMoveToWorkspaceRequest(workspace, address, grammar));
      yield* logPlacementDebug("window returned to workspace", { windowId, workspace: target });
    });

    return HyprlandPlacement.of({
      isAvailable,
      claim,
      forget: (windowId) => Effect.sync(() => void addressesByWindowId.delete(windowId)),
      workspaceOf,
      stageWorkspaceRule,
      clearWorkspaceRule,
      moveToWorkspace,
    });
  });

export const layer = Layer.effect(
  HyprlandPlacement,
  Effect.suspend(() => make({ environment: readHyprlandSocketEnvironment(), pid: process.pid })),
);
