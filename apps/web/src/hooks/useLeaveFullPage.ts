import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

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
