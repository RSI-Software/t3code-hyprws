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
 *
 * The same address map, joined with each window's published project filter, is
 * written out for tools outside the app (`WindowProjectManifest.fork.ts`).
 */
import type { DesktopWindowProjectScope } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import {
  formatClearSuppressionWindowRule,
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
import {
  buildWindowProjectManifest,
  removeWindowProjectManifest,
  windowProjectManifestPath,
  writeWindowProjectManifest,
  type WindowProjectManifest,
} from "./WindowProjectManifest.fork.ts";

const { logDebug: logPlacementDebug, logWarning: logPlacementWarning } =
  makeComponentLogger("desktop.hyprland");

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
    readonly claim: (
      windowId: WindowId,
      title: string,
      options?: ClaimBaseline,
    ) => Effect.Effect<void>;
    /** Our client addresses now; taken before a show, it lets a retitled window be claimed. */
    readonly snapshotAddresses: Effect.Effect<ReadonlySet<string>>;
    readonly forget: (windowId: WindowId) => Effect.Effect<void>;
    /** Records the projects a window's filter shows, for the window manifest. */
    readonly publishScope: (
      windowId: WindowId,
      scope: DesktopWindowProjectScope,
    ) => Effect.Effect<void>;
    readonly workspaceOf: (
      windowId: WindowId,
    ) => Effect.Effect<Option.Option<HyprlandWorkspaceRef>>;
    /**
     * Stages a title-scoped rule before a hidden window maps. A `transient`
     * title (one window's claim token) only gets rules its clear removes.
     */
    readonly stageWorkspaceRule: (
      title: string,
      workspace: HyprlandWorkspaceRef,
      options?: RuleLifetime,
    ) => Effect.Effect<boolean>;
    /** Removes the staged rules; a `transient` title loses every rule and global. */
    readonly clearWorkspaceRule: (title: string, options?: RuleLifetime) => Effect.Effect<void>;
    /** Moves a claimed window to `workspace` without switching the view. */
    readonly moveToWorkspace: (
      windowId: WindowId,
      workspace: HyprlandWorkspaceRef,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/HyprlandPlacement") {}

export interface ClaimBaseline {
  readonly knownAddresses?: ReadonlySet<string>;
}

export interface RuleLifetime {
  readonly transient?: boolean;
}

export const make = (options: {
  readonly environment: HyprlandSocketEnvironment;
  readonly pid: number;
  readonly claimAttempts?: number;
  readonly claimIntervalMs?: number;
  /** The socket round trip, injectable so tests need no compositor. */
  readonly requestHyprland?: (
    environment: HyprlandSocketEnvironment,
    payload: string,
  ) => Promise<string>;
  /** Where the window manifest goes; omitted or null writes none. */
  readonly manifestPath?: string | null;
  /** Required with `manifestPath`; the layer supplies the file system write. */
  readonly writeManifest?: (path: string, manifest: WindowProjectManifest) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const addressesByWindowId = new Map<WindowId, string>();
    const scopesByWindowId = new Map<WindowId, DesktopWindowProjectScope>();
    // Titles with a staged rule: their windows claim by exact title only.
    const stagedTitles = new Set<string>();
    const isAvailable = (options.environment.instanceSignature?.trim() ?? "").length > 0;
    const claimAttempts = options.claimAttempts ?? CLAIM_ATTEMPTS;
    const claimIntervalMs = options.claimIntervalMs ?? CLAIM_INTERVAL_MS;
    let windowRuleGrammar: HyprlandWindowRuleGrammar | undefined;
    const send = options.requestHyprland ?? requestHyprland;
    const manifestPath = isAvailable ? (options.manifestPath ?? null) : null;
    const writeManifest = options.writeManifest;
    // One write at a time, each built from the maps as they stand when it runs,
    // so the file always ends at the latest state.
    const manifestLock = yield* Semaphore.make(1);
    const publishManifest =
      manifestPath === null || writeManifest === undefined
        ? Effect.void
        : manifestLock.withPermits(1)(
            Effect.suspend(() =>
              writeManifest(
                manifestPath,
                buildWindowProjectManifest({
                  pid: options.pid,
                  addresses: addressesByWindowId,
                  scopes: scopesByWindowId,
                }),
              ),
            ),
          );

    const request = (payload: string) =>
      Effect.tryPromise(() => send(options.environment, payload)).pipe(Effect.option);

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
      baseline?: ClaimBaseline,
    ) {
      if (!isAvailable || addressesByWindowId.has(windowId)) return;
      for (let attempt = 0; attempt < claimAttempts; attempt += 1) {
        const clients = yield* readClients;
        // Select and record with no yield between them: claims are serialized
        // by construction, so two windows mapping at once never share a client.
        const client = selectClientForWindow({
          clients,
          pid: options.pid,
          title,
          claimedAddresses: new Set(addressesByWindowId.values()),
          ...(baseline?.knownAddresses === undefined
            ? {}
            : { knownAddresses: baseline.knownAddresses, reservedTitles: stagedTitles }),
        });
        if (client !== null) {
          addressesByWindowId.set(windowId, client.address);
          yield* publishManifest;
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
      lifetime?: RuleLifetime,
    ) {
      if (!isAvailable) return false;
      const grammar = yield* resolveWindowRuleGrammar();
      const workspacePayload = formatWorkspaceWindowRule(workspace, title, grammar);
      if (workspacePayload === null) return false;
      stagedTitles.add(title);
      // The exact worktree title keeps the activation guard safe to retain,
      // which also covers every Electron restart owned by the development watcher.
      // A transient title gets it only where its clear can remove it again.
      const suppressionPayload =
        lifetime?.transient === true && formatClearSuppressionWindowRule(title, grammar) === null
          ? undefined
          : formatSuppressActivationWindowRule(title, grammar);
      if (suppressionPayload === null) return false;
      const workspaceResult = yield* request(workspacePayload);
      if (suppressionPayload === undefined) return Option.isSome(workspaceResult);
      const suppressionResult = yield* request(suppressionPayload);
      return Option.isSome(workspaceResult) && Option.isSome(suppressionResult);
    });

    const clearWorkspaceRule = Effect.fn("desktop.hyprland.clearWorkspaceRule")(function* (
      title: string,
      lifetime?: RuleLifetime,
    ) {
      if (!isAvailable) return;
      const grammar = yield* resolveWindowRuleGrammar();
      stagedTitles.delete(title);
      const payload = formatClearWorkspaceWindowRule(title, grammar);
      if (payload !== null) yield* request(payload);
      if (lifetime?.transient !== true) return;
      const suppression = formatClearSuppressionWindowRule(title, grammar);
      if (suppression !== null) yield* request(suppression);
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

    const snapshotAddresses = readClients.pipe(
      Effect.map(
        (clients): ReadonlySet<string> =>
          new Set(
            clients.filter((client) => client.pid === options.pid).map((client) => client.address),
          ),
      ),
    );

    return HyprlandPlacement.of({
      isAvailable,
      claim,
      snapshotAddresses: isAvailable ? snapshotAddresses : Effect.succeed(new Set<string>()),
      forget: (windowId) =>
        Effect.sync(() => {
          addressesByWindowId.delete(windowId);
          scopesByWindowId.delete(windowId);
        }).pipe(Effect.andThen(publishManifest)),
      publishScope: (windowId, scope) =>
        Effect.sync(() => void scopesByWindowId.set(windowId, scope)).pipe(
          Effect.andThen(publishManifest),
        ),
      workspaceOf,
      stageWorkspaceRule,
      clearWorkspaceRule,
      moveToWorkspace,
    });
  });

export const layer = Layer.effect(
  HyprlandPlacement,
  Effect.gen(function* () {
    const environment = readHyprlandSocketEnvironment();
    const manifestPath = windowProjectManifestPath(environment.runtimeDirectory, process.pid);
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    // Best-effort like every placement operation: a failed write is logged once, never raised.
    let warned = false;
    const withFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.asVoid,
        Effect.catchCause((cause) => {
          if (warned) return Effect.void;
          warned = true;
          return logPlacementWarning("window manifest update failed", { cause: String(cause) });
        }),
      );
    // Removal shares the writes' lock and stops later ones, so a write still in
    // flight from a closing window cannot land after it.
    const fileLock = yield* Semaphore.make(1);
    let closed = false;
    const placement = yield* make({
      environment,
      pid: process.pid,
      manifestPath,
      writeManifest: (path, manifest) =>
        fileLock.withPermits(1)(
          Effect.suspend(() =>
            closed ? Effect.void : withFiles(writeWindowProjectManifest(path, manifest)),
          ),
        ),
    });
    if (placement.isAvailable && manifestPath !== null) {
      yield* Effect.addFinalizer(() =>
        fileLock.withPermits(1)(
          Effect.suspend(() => {
            closed = true;
            return withFiles(removeWindowProjectManifest(manifestPath));
          }),
        ),
      );
    }
    return placement;
  }),
);
