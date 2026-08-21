import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { readDesktopProjectWindowRef } from "../desktopProjectWindows";

/**
 * Back-out navigation for the whole-app pages (settings, usage, pull requests)
 * that replace the view. The hub returns to the last main app URL. A desktop
 * project window steps back in its own history, or lands on its project: never
 * the hub, which the window is not allowed to show.
 */
export function useFullPageBackOut() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const navigateToMainApp = useNavigateToMainApp();

  return useCallback(() => {
    const projectWindowRef = readDesktopProjectWindowRef();
    if (!projectWindowRef) {
      void navigateToMainApp();
      return;
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({
      to: "/project/$environmentId/$projectId",
      params: {
        environmentId: projectWindowRef.environmentId,
        projectId: projectWindowRef.projectId,
      },
    });
  }, [canGoBack, navigate, navigateToMainApp]);
}

/** The back-out above, plus the Escape shortcut the settings pages bind to it. */
export function useLeaveFullPage() {
  const leave = useFullPageBackOut();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      event.preventDefault();

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }

      leave();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [leave]);

  return leave;
}
