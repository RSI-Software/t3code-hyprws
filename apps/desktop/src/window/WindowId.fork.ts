/**
 * The opaque id main mints for each desktop window it creates.
 *
 * Everything that keys a window (the registry, preview ownership, Hyprland
 * claims, the update-restore manifest) keys it by this id. Which project a
 * window shows is data about the window, never its key, so two windows may
 * show the same thing and one window may change what it shows.
 *
 * The id rides into the renderer as a preload argument. Electron replays a
 * window's `additionalArguments` into every renderer process it starts, so a
 * reload or crash recovery reads the same id back.
 *
 * Kept free of package imports so the sandboxed preload can use it; see
 * `projectWindowArgument.ts` for why. Main mints ids in `WindowRegistry.fork.ts`.
 */
export type WindowId = string & { readonly __windowIdBrand: unique symbol };

export const WINDOW_ID_PRELOAD_ARGUMENT = "--t3code-window-id";

const WINDOW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isWindowId(value: unknown): value is WindowId {
  return typeof value === "string" && WINDOW_ID_PATTERN.test(value);
}

export function windowIdPreloadArgument(windowId: WindowId): string {
  return `${WINDOW_ID_PRELOAD_ARGUMENT}=${windowId}`;
}

export function readWindowIdPreloadArgument(argv: readonly string[]): WindowId | null {
  const prefix = `${WINDOW_ID_PRELOAD_ARGUMENT}=`;
  for (const argument of argv) {
    if (!argument.startsWith(prefix)) continue;
    const value = argument.slice(prefix.length);
    if (isWindowId(value)) return value;
  }
  return null;
}
