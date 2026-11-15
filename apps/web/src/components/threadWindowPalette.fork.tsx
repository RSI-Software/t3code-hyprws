// Fork-owned command-palette entry for opening the active thread in its own desktop window;
// upstream `CommandPalette.tsx` carries only marked hook lines pointing here.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";

import { canOpenDesktopWindow, openThreadInNewWindow } from "../desktopWindows.fork";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";

/** The thread menus' "Open in New Window", where this client opens desktop windows. */
export function buildOpenThreadWindowActionItemFork(
  activeThread:
    | {
        readonly environmentId: EnvironmentId;
        readonly id: ThreadId;
        readonly projectId: ProjectId;
      }
    | null
    | undefined,
): CommandPaletteActionItem | null {
  if (activeThread == null || !canOpenDesktopWindow()) return null;
  const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
  return {
    kind: "action",
    value: "action:open-thread-window",
    searchTerms: ["open", "thread", "window", "desktop", "separate", "pop out"],
    title: "Open thread in new window",
    icon: <ExternalLinkIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openThreadInNewWindow(threadRef, activeThread.projectId);
    },
  };
}
