import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { validateGitHubIssueSearch } from "../components/githubIssue/githubIssueRouteSearch";
import { resolveProjectRouteRef } from "../projectRoutes";
import { GitHubIssuesPage } from "./_chat.issues";

function ProjectGitHubIssuesRoute() {
  const forcedProjectRef = Route.useParams({ select: resolveProjectRouteRef });
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (forcedProjectRef === null) return null;
  return (
    <GitHubIssuesPage
      forcedProjectRef={forcedProjectRef}
      search={search}
      onNavigate={(update) => void navigate({ search: update, replace: true })}
    />
  );
}

export const Route = createFileRoute("/project/$environmentId/$projectId/issues")({
  validateSearch: validateGitHubIssueSearch,
  component: ProjectGitHubIssuesRoute,
});
