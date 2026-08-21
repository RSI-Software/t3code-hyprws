import type { DesktopBridge, ScopedProjectRef } from "@t3tools/contracts";

export type DesktopProjectWindowBridge = DesktopBridge & {
  readonly openProjectWindow: NonNullable<DesktopBridge["openProjectWindow"]>;
};

export function supportsDesktopProjectWindows(
  bridge: DesktopBridge | undefined,
): bridge is DesktopProjectWindowBridge {
  return typeof bridge?.openProjectWindow === "function";
}

/**
 * The project owning this window, or null everywhere else (hub window, web,
 * mobile). Shared pages such as settings read it to return to the project this
 * window is scoped to instead of the hub route.
 */
export function readDesktopProjectWindowRef(): ScopedProjectRef | null {
  if (typeof window === "undefined") return null;
  return window.desktopBridge?.projectWindowRef ?? null;
}
