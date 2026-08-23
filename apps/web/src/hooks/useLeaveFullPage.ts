import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { readDesktopProjectWindowRef } from "../desktopProjectWindows";

/**
 * Back-out navigation for the whole-app pages (settings, usage, pull requests)
 * that replace the view. In a desktop project window the fallback lands on that
 * window's project instead of the hub, which the window is not allowed to show.
 */
export function useFullPageBackOut() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();

  return useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    const projectWindowRef = readDesktopProjectWindowRef();
    if (projectWindowRef) {
      void navigate({
        to: "/project/$environmentId/$projectId",
        params: {
          environmentId: projectWindowRef.environmentId,
          projectId: projectWindowRef.projectId,
        },
      });
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);
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
