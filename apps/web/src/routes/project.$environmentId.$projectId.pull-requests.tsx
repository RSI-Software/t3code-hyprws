import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { validatePullRequestsSearch } from "../components/pullRequest/pullRequestListRoute";
import { resolveProjectRouteRef } from "../projectRoutes";
import { PullRequestsPage } from "./_chat.pull-requests";

function ProjectPullRequestsRouteView() {
  const forcedProjectRef = Route.useParams({ select: resolveProjectRouteRef });
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (forcedProjectRef === null) return null;

  return (
    <PullRequestsPage
      forcedProjectRef={forcedProjectRef}
      search={search}
      onNavigate={(update) => void navigate({ search: update, replace: true })}
    />
  );
}

export const Route = createFileRoute("/project/$environmentId/$projectId/pull-requests")({
  validateSearch: validatePullRequestsSearch,
  component: ProjectPullRequestsRouteView,
});
