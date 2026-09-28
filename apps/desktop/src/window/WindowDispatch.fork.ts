import type { DesktopWindowRequest, ScopedProjectRef, WindowScopeSeed } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveWindowIdentityFromArguments } from "./DesktopLaunchIntent.ts";
import { isWindowId, type WindowId } from "./WindowId.fork.ts";
import { HUB_WINDOW_IDENTITY, type WindowIdentity } from "./WindowIdentity.ts";

/**
 * Fork-only: every way a window gets opened or focused, answered by one table
 * (RSI-Software/t3code-hyprws#1343).
 *
 * | Request                   | Behavior                                        |
 * | ------------------------- | ----------------------------------------------- |
 * | `new-window`              | Create at `/`, all projects                     |
 * | `open-in-new-window`      | Create at that route, seed the filter           |
 * | `activate`                | Focus the most recent window, else create       |
 * | `project-link`            | Reuse a window showing it, else create filtered |
 * | `focus`                   | Focus if open; never resurrect                  |
 * | `callback`                | Unchanged: reveal or create the primary window  |
 *
 * Clients send the first three (see `DesktopWindowRequest`); argv produces
 * the launch rows. The startup drain queues these same requests, so a launch
 * that lands before the backend is ready takes the same row once it drains.
 */
export type WindowRequest =
  | DesktopWindowRequest
  | { readonly kind: "activate" }
  | { readonly kind: "project-link"; readonly ref: ScopedProjectRef }
  | { readonly kind: "callback" };

/**
 * A window to create. `seed` is the sidebar scope handed to the new window
 * through its preload argument (`desktopBridge.windowScopeSeed`): a project,
 * or `"all-projects"` for New Window.
 */
export interface WindowCreateRequest {
  readonly route: string;
  readonly seed: WindowScopeSeed;
}

export const NEW_WINDOW_ROUTE = "/";

function projectWindowRoute(ref: ScopedProjectRef): string {
  return `/project/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.projectId)}`;
}

/** What a created window records as its identity: its seed project, or the hub for all projects. */
export function windowIdentityForSeed(seed: WindowScopeSeed): WindowIdentity {
  return seed === "all-projects" ? HUB_WINDOW_IDENTITY : { kind: "project", ref: seed };
}

/**
 * Classifies launch argv. A project argument is a deep link; any other
 * desktop-protocol URL is an OAuth callback; everything else is a plain
 * second launch.
 */
export function resolveLaunchRequest(argv: readonly string[]): WindowRequest {
  const identity = resolveWindowIdentityFromArguments(argv);
  if (identity?.kind === "project") return { kind: "project-link", ref: identity.ref };
  const isCallback = argv.some((argument) => {
    const trimmed = argument.trim();
    return trimmed.startsWith("t3code://") || trimmed.startsWith("t3code-dev://");
  });
  return isCallback ? { kind: "callback" } : { kind: "activate" };
}

/** Only a deep link queues past a pending update restore; see the startup drain. */
export function isExplicitLaunchRequest(request: WindowRequest): boolean {
  return request.kind !== "activate" && request.kind !== "callback";
}

/**
 * The window operations the table is written against. Created windows reveal
 * themselves on ready-to-show, so the table only reveals windows that
 * already existed.
 */
export interface WindowDispatchOps<W, E> {
  readonly create: (request: WindowCreateRequest) => Effect.Effect<unknown, E>;
  /** The primary window's unchanged path: reveal it, creating it if needed. */
  readonly openPrimary: Effect.Effect<unknown, E>;
  /** Create the primary window when none is open; never takes the foreground. */
  readonly createPrimary: Effect.Effect<unknown, E>;
  readonly mostRecent: Effect.Effect<Option.Option<W>>;
  readonly showing: (ref: ScopedProjectRef) => Effect.Effect<Option.Option<W>>;
  readonly byId: (windowId: WindowId) => Effect.Effect<Option.Option<W>>;
  readonly reveal: (window: W) => Effect.Effect<void>;
}

const revealIfSome = <W, E>(
  ops: WindowDispatchOps<W, E>,
  window: Effect.Effect<Option.Option<W>>,
): Effect.Effect<boolean> =>
  window.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(false),
        onSome: (found) => ops.reveal(found).pipe(Effect.as(true)),
      }),
    ),
  );

export const dispatchWindowRequest =
  <W, E>(ops: WindowDispatchOps<W, E>) =>
  (request: WindowRequest): Effect.Effect<void, E> => {
    switch (request.kind) {
      case "new-window":
        return ops.create({ route: NEW_WINDOW_ROUTE, seed: "all-projects" }).pipe(Effect.asVoid);
      case "open-in-new-window":
        return ops.create({ route: request.route, seed: request.seed }).pipe(Effect.asVoid);
      case "activate":
        return revealIfSome(ops, ops.mostRecent).pipe(
          Effect.flatMap((revealed) => (revealed ? Effect.void : Effect.asVoid(ops.createPrimary))),
        );
      case "project-link":
        return revealIfSome(ops, ops.showing(request.ref)).pipe(
          Effect.flatMap((revealed) =>
            revealed
              ? Effect.void
              : ops
                  .create({ route: projectWindowRoute(request.ref), seed: request.ref })
                  .pipe(Effect.asVoid),
          ),
        );
      case "focus":
        return isWindowId(request.windowId)
          ? revealIfSome(ops, ops.byId(request.windowId)).pipe(Effect.asVoid)
          : Effect.void;
      case "callback":
        return Effect.asVoid(ops.openPrimary);
    }
  };
