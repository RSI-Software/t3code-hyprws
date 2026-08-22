import type { DesktopBridge } from "@t3tools/contracts";

export type DesktopProjectWindowBridge = DesktopBridge & {
  readonly openProjectWindow: NonNullable<DesktopBridge["openProjectWindow"]>;
};

export function supportsDesktopProjectWindows(
  bridge: DesktopBridge | undefined,
): bridge is DesktopProjectWindowBridge {
  return typeof bridge?.openProjectWindow === "function";
}
