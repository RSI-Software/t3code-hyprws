/**
 * The opaque key for each desktop window; what it shows is data, never the key.
 * It rides in as a preload argument Electron replays on reload. No package
 * imports: a preload pulling in `@t3tools/*` leaves a runtime `require()` that
 * fails to load and drops the whole desktop bridge.
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
