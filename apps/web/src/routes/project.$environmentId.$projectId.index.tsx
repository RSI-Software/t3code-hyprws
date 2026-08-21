import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { DraftStartError } from "../components/DraftStartError";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { resolveProjectRouteRef } from "../projectRoutes";

export function ProjectIndexRouteView() {
  const projectRef = Route.useParams({ select: resolveProjectRouteRef });
  const handleNewThread = useNewThreadHandler();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  useEffect(() => {
    if (projectRef === null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(projectRef, { replace: true }).catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [handleNewThread, projectRef, startState.retryRequest]);

  return (
    <ProjectIndexRouteContent
      failed={startState.failed}
      onRetry={() => {
        setStartState((state) => ({
          failed: false,
          retryRequest: state.retryRequest + 1,
        }));
      }}
    />
  );
}

export function ProjectIndexRouteContent({
  failed,
  onRetry,
}: {
  readonly failed: boolean;
  readonly onRetry: () => void;
}) {
  return failed ? <DraftStartError onRetry={onRetry} /> : null;
}

export const Route = createFileRoute("/project/$environmentId/$projectId/")({
  component: ProjectIndexRouteView,
});
