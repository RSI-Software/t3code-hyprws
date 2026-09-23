// Fork-owned: the sidebar's "open project window" desktop bridge action
// (feat(web): open project windows from hub actions). The upstream
// `Sidebar.tsx` carries only marked hook lines pointing here: the bridge
// probe, the open-window callback, the rendered button, and the settings
// button's desktop-aware class name.
import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { ExternalLinkIcon } from "lucide-react";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  supportsDesktopProjectWindows,
  type DesktopProjectWindowBridge,
} from "../desktopProjectWindows";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";

/** The desktop bridge, when the current window supports opening project windows. */
export const useDesktopProjectWindowBridgeFork = (): DesktopProjectWindowBridge | null =>
  typeof window !== "undefined" && supportsDesktopProjectWindows(window.desktopBridge)
    ? window.desktopBridge
    : null;

/** The sidebar row's "open project window" click handler. */
export const useOpenProjectWindowFork = (
  desktopBridge: DesktopProjectWindowBridge | null,
  closeProjectScopeMenu: () => void,
): ((event: ReactMouseEvent<HTMLButtonElement>, projectGroup: SidebarProjectSnapshot) => void) =>
  useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, projectGroup: SidebarProjectSnapshot) => {
      event.preventDefault();
      event.stopPropagation();
      closeProjectScopeMenu();
      if (!desktopBridge) return;
      void desktopBridge
        .openProjectWindow(scopeProjectRef(projectGroup.environmentId, projectGroup.id))
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to open project window",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
    },
    [desktopBridge, closeProjectScopeMenu],
  );

/** The row's "open in new window" button, rendered only when the desktop bridge supports it. */
export function SidebarOpenProjectWindowButtonFork(props: {
  readonly desktopBridge: DesktopProjectWindowBridge | null;
  readonly project: SidebarProjectSnapshot;
  readonly onOpen: (
    event: ReactMouseEvent<HTMLButtonElement>,
    project: SidebarProjectSnapshot,
  ) => void;
}) {
  if (!props.desktopBridge) return null;
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      tabIndex={-1}
      aria-hidden="true"
      title={`Open ${props.project.displayName} in new window`}
      className="ml-auto"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        props.onOpen(event, props.project);
      }}
    >
      <ExternalLinkIcon className="size-3.5" />
    </Button>
  );
}
