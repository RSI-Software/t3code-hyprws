import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { useEscapeToGoBack } from "../hooks/useNavigateBack";
import { useFullPageBackOut } from "../hooks/useLeaveFullPage";
import { resolveProjectRouteRef } from "../projectRoutes";
import { PullRequestsPage, validatePullRequestsSearch } from "./_chat.pull-requests";

function ProjectPullRequestsRouteView() {
  useEscapeToGoBack(useFullPageBackOut());
  const forcedProjectRef = Route.useParams({ select: resolveProjectRouteRef });
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (forcedProjectRef === null) return null;

  return (
    <PullRequestsPage
      forcedProjectRef={forcedProjectRef}
      search={search}
      onNavigate={(options) => void navigate(options)}
    />
  );
}

export const Route = createFileRoute("/project/$environmentId/$projectId/pull-requests")({
  validateSearch: validatePullRequestsSearch,
  component: ProjectPullRequestsRouteView,
});
