import type { IssueError, IssueRef, IssueScopeRef, IssueSummary } from "@t3tools/contracts";
import type {
  IssueTrackerApi,
  IssueTrackerError,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";

export type IssueSummaryFork = (input: IssueRef) => Effect.Effect<IssueSummary, IssueError>;

/**
 * A chat chip's read: title and state without the conversation. A tracker that batches it (Linear)
 * answers every chip in a view with one call; any other reads the detail and drops the rest.
 */
export const issueSummaryFork =
  (
    requireProject: (ref: IssueScopeRef) => Effect.Effect<
      {
        readonly project: { readonly workspaceRoot: string };
        readonly tracker: IssueSummary["tracker"];
        readonly host: string;
        readonly scope: string;
        readonly api: IssueTrackerApi;
      },
      IssueError
    >,
    toIssueError: (operation: string) => (error: IssueTrackerError) => IssueError,
  ): IssueSummaryFork =>
  (input) =>
    Effect.flatMap(requireProject(input), (project) =>
      (project.api.getIssueSummaryFork ?? project.api.getIssue)({
        cwd: project.project.workspaceRoot,
        host: project.host,
        scope: project.scope,
        key: input.key,
      }).pipe(
        Effect.mapError(toIssueError("detail")),
        Effect.map((issue): IssueSummary => ({
          tracker: project.tracker,
          host: project.host,
          scope: project.scope,
          key: issue.key,
          displayKey: issue.displayKey,
          title: issue.title,
          url: issue.url,
          author: issue.author,
          state: issue.state,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          closedAt: issue.closedAt,
          assignees: issue.assignees,
          labels: issue.labels,
          commentCount: issue.commentCount,
        })),
      ),
    );
