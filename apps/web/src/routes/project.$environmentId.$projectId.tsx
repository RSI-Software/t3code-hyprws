import type { ScopedProjectRef } from "@t3tools/contracts";
import { Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { resolveProjectAvailabilityRedirect, resolveProjectRouteRef } from "../projectRoutes";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { ChatRouteGlobalShortcuts } from "./_chat";

function ProjectRouteLayout() {
  const navigate = useNavigate();
  const projectRef = Route.useParams({ select: resolveProjectRouteRef });
  const shell = useEnvironmentQuery(
    projectRef === null ? null : environmentShell.stateAtom(projectRef.environmentId),
  );
  const authoritativeSnapshot =
    shell.data?.status === "live" && shell.data.snapshot._tag === "Some"
      ? shell.data.snapshot.value
      : null;
  const environmentProjectPresence = authoritativeSnapshot
    ? authoritativeSnapshot.projects.some((candidate) => candidate.id === projectRef?.projectId)
      ? "present"
      : "absent"
    : "pending";
  const redirectTarget = resolveProjectAvailabilityRedirect({
    routeRef: projectRef,
    environmentProjectPresence,
  });

  useEffect(() => {
    if (redirectTarget === "hub") {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, redirectTarget]);

  return <ProjectRouteContent projectRef={projectRef} />;
}

export function ProjectRouteContent({
  projectRef,
}: {
  readonly projectRef: ScopedProjectRef | null;
}) {
  if (projectRef === null) {
    return null;
  }

  return (
    <>
      <ChatRouteGlobalShortcuts forcedProjectRef={projectRef} />
      <AppSidebarLayout forcedProjectRef={projectRef}>
        <Outlet />
      </AppSidebarLayout>
    </>
  );
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
