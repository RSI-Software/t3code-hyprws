import type { DesktopBridge } from "@t3tools/contracts";

export type PreviewCapableDesktopBridge = DesktopBridge & {
  readonly preview: NonNullable<DesktopBridge["preview"]>;
};

/** Keep the fork policy at one seam without rebuilding the upstream bridge. */
export function exposePreviewCapability<Bridge extends PreviewCapableDesktopBridge>(
  bridge: Bridge,
): Bridge {
  return bridge;
}
