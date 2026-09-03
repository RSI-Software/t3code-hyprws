import type { DesktopBridge } from "@t3tools/contracts";

/** Keep the fork's supported preview capability behind one narrow preload seam. */
export function exposePreviewCapability(
  bridge: Omit<DesktopBridge, "preview">,
  preview: NonNullable<DesktopBridge["preview"]>,
): DesktopBridge {
  return { ...bridge, preview };
}
