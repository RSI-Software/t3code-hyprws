import { Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { resolveProjectAvailabilityRedirect, resolveProjectRouteRef } from "../projectRoutes";
import { useAllEnvironmentShellsBootstrapped, useProject } from "../state/entities";

function ProjectRouteLayout() {
  const navigate = useNavigate();
  const projectRef = Route.useParams({ select: resolveProjectRouteRef });
  const project = useProject(projectRef);
  const bootstrapComplete = useAllEnvironmentShellsBootstrapped();
  const redirectTarget = resolveProjectAvailabilityRedirect({
    routeRef: projectRef,
    bootstrapComplete,
    projectExists: project !== null,
  });

  useEffect(() => {
    if (redirectTarget === "hub") {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, redirectTarget]);

  if (projectRef === null || project === null) {
    return null;
  }

  return <Outlet />;
}

export const Route = createFileRoute("/project/$environmentId/$projectId")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ProjectRouteLayout,
});
