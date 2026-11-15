import type { EnvironmentId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import type { IssueSurfaceFork } from "../../rightPanelStore.fork";
import { useEnvironmentQuery } from "../../state/query";
import { issueStatePresentation } from "./issuePresentation";
import { useIssueReferenceAtom } from "./issueReference.fork";

/** The issue tab's glyph in its state's tone, as a pull request tab wears its own. */
export function IssueTabIconFork({ surface }: { readonly surface: IssueSurfaceFork }) {
  const { data } = useEnvironmentQuery(
    useIssueReferenceAtom({
      environmentId: surface.environmentId as EnvironmentId,
      projectId: surface.projectId,
      repository: surface.repository,
      number: surface.number,
    }),
  );
  const presentation =
    data === null || data.kind !== "issue"
      ? null
      : issueStatePresentation(
          data.state === "open" ? "open" : "closed",
          data.state === "closed" ? "completed" : "not planned",
        );
  const Icon = presentation?.Icon ?? issueStatePresentation("open").Icon;
  return (
    <Icon
      role="img"
      aria-label={presentation?.label ?? "Issue"}
      className={cn("size-3 shrink-0", presentation?.toneClassName ?? "text-muted-foreground")}
    />
  );
}
