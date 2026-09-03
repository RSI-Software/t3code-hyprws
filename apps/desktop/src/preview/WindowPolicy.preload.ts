import type { DesktopBridge } from "@t3tools/contracts";

import { isProjectWindowPreload } from "../window/projectWindowArgument.ts";

/** Keep the unsupported project-window preview path explicit in the sandboxed preload bundle. */
export function exposePreviewCapability(
  argv: readonly string[],
  bridge: Omit<DesktopBridge, "preview">,
  preview: NonNullable<DesktopBridge["preview"]>,
): DesktopBridge {
  return isProjectWindowPreload(argv) ? bridge : { ...bridge, preview };
}
