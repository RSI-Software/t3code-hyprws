import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import type { GitHubIssueSurfaceFork } from "../../rightPanelStore.fork";
import { githubIssueEnvironment } from "../../state/githubIssues";
import { useEnvironmentQuery } from "../../state/query";
import { githubIssueStatePresentation } from "./githubIssuePresentation";

/** The issue tab's glyph in its state's tone, as a pull request tab wears its own. */
export function GitHubIssueTabIconFork({ surface }: { readonly surface: GitHubIssueSurfaceFork }) {
  // The panel reads this same issue, so the tab shares its answer rather than asking again.
  const { data } = useEnvironmentQuery(
    githubIssueEnvironment.detail({
      environmentId: surface.environmentId as EnvironmentId,
      input: {
        projectId: surface.projectId as ProjectId,
        repository: surface.repository,
        number: surface.number,
      },
    }),
  );
  const presentation =
    data === null ? null : githubIssueStatePresentation(data.state, data.closeReason);
  const Icon = presentation?.Icon ?? githubIssueStatePresentation("open").Icon;
  return (
    <Icon
      role="img"
      aria-label={presentation?.label ?? "Issue"}
      className={cn("size-3 shrink-0", presentation?.toneClassName ?? "text-muted-foreground")}
    />
  );
}
