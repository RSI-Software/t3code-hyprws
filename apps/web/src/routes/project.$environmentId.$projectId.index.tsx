import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { resolveProjectRouteRef } from "../projectRoutes";

function ProjectIndexRouteView() {
  const projectRef = Route.useParams({ select: resolveProjectRouteRef });
  const handleNewThread = useNewThreadHandler();
  const startingRef = useRef(false);

  useEffect(() => {
    if (projectRef === null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(projectRef, { replace: true }).catch(() => {
      startingRef.current = false;
    });
  }, [handleNewThread, projectRef]);

  return null;
}

export const Route = createFileRoute("/project/$environmentId/$projectId/")({
  component: ProjectIndexRouteView,
});
