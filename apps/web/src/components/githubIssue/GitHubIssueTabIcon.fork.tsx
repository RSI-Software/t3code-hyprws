import type { EnvironmentId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import type { GitHubIssueSurfaceFork } from "../../rightPanelStore.fork";
import { useServerConfigs } from "../../state/entities";
import { githubIssueEnvironment } from "../../state/githubIssues";
import { useEnvironmentQuery } from "../../state/query";
import { githubIssueStatePresentation } from "./githubIssuePresentation";

/** The issue tab's glyph in its state's tone, as a pull request tab wears its own. */
export function GitHubIssueTabIconFork({ surface }: { readonly surface: GitHubIssueSurfaceFork }) {
  const environmentId = surface.environmentId as EnvironmentId;
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.githubIssues === true;
  // The chat chips' reference read: state alone, cached long, never the issue's full detail.
  const { data } = useEnvironmentQuery(
    supported
      ? githubIssueEnvironment.reference({
          environmentId,
          input: { host: "github.com", repository: surface.repository, number: surface.number },
        })
      : null,
  );
  const presentation =
    data === null || data.kind !== "issue"
      ? null
      : githubIssueStatePresentation(
          data.state === "open" ? "open" : "closed",
          data.state === "closed" ? "completed" : "not planned",
        );
  const Icon = presentation?.Icon ?? githubIssueStatePresentation("open").Icon;
  return (
    <Icon
      role="img"
      aria-label={presentation?.label ?? "Issue"}
      className={cn("size-3 shrink-0", presentation?.toneClassName ?? "text-muted-foreground")}
    />
  );
}
