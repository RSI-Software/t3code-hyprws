import type {
  GitHubIssueCliMissingError,
  GitHubIssueCliUnauthenticatedError,
  GitHubIssueDetail,
  GitHubIssueListEntry,
  GitHubIssueListInput,
  GitHubIssueListResult,
  GitHubIssueOperationError,
  GitHubIssueRef,
  OrchestrationProjectShell,
} from "@t3tools/contracts";
import {
  GitHubIssueCliMissingError as GitHubIssueCliMissingErrorClass,
  GitHubIssueCliUnauthenticatedError as GitHubIssueCliUnauthenticatedErrorClass,
  GitHubIssueOperationError as GitHubIssueOperationErrorClass,
  pullRequestHostOf,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { repositoryIdentityOf } from "../pullRequest/PullRequestService.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { decodeGitHubIssueDetail, decodeGitHubIssueList } from "./gitHubIssueJson.ts";

const DEFAULT_LIMIT = 50;
const PROJECT_CONCURRENCY = 8;
const DETAIL_COMMENT_LIMIT = 100;
// `issueType` and `subIssues` need a recent `gh`; an older CLI rejects the unknown field name and
// degrades the whole project, which the list already reports per project rather than swallowing.
// `comments` is asked for by count alone: `gh` has no count field, and the entry keeps only the
// length, so the cost is one subprocess read rather than anything crossing the socket.
const ISSUE_LIST_FIELDS =
  "number,title,url,author,assignees,labels,issueType,state,createdAt,updatedAt,comments,reactionGroups";
const ISSUE_DETAIL_FIELDS = `${ISSUE_LIST_FIELDS},body,subIssues,closedAt`;

type GitHubIssueCliError = GitHubIssueCliMissingError | GitHubIssueCliUnauthenticatedError;
type GitHubIssueError = GitHubIssueCliError | GitHubIssueOperationError;

interface GitHubProject {
  readonly project: OrchestrationProjectShell;
  readonly repository: string;
  readonly host: string;
}

interface GitHubIssueProjectFailure {
  readonly project: GitHubProject;
  readonly error: GitHubIssueCliUnauthenticatedError | GitHubIssueOperationError;
}

export class GitHubIssueService extends Context.Service<
  GitHubIssueService,
  {
    readonly list: (
      input: GitHubIssueListInput,
    ) => Effect.Effect<GitHubIssueListResult, GitHubIssueError>;
    readonly detail: (input: GitHubIssueRef) => Effect.Effect<GitHubIssueDetail, GitHubIssueError>;
  }
>()("t3/githubIssue/GitHubIssueService") {}

function cliRepository(project: GitHubProject, repository = project.repository): string {
  return `${project.host}/${repository}`;
}

function authCommandForHost(host: string): string {
  return host === "github.com" ? "gh auth login" : `gh auth login --hostname ${host}`;
}

function fromCliError(operation: string, host: string) {
  return (error: GitHubCli.GitHubCliError): GitHubIssueError => {
    if (error._tag === "GitHubCliUnavailableError") {
      return new GitHubIssueCliMissingErrorClass({ cause: error });
    }
    if (error._tag === "GitHubCliAuthenticationError") {
      return new GitHubIssueCliUnauthenticatedErrorClass({ host, cause: error });
    }
    return new GitHubIssueOperationErrorClass({ operation, detail: error.detail, cause: error });
  };
}

function decodeError(operation: string, cause: unknown): GitHubIssueOperationError {
  return new GitHubIssueOperationErrorClass({
    operation,
    detail: "GitHub CLI returned unreadable issue data.",
    cause,
  });
}

export const make = Effect.gen(function* () {
  const cli = yield* GitHubCli.GitHubCli;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const workspaceProjects = Effect.fn("GitHubIssueService.workspaceProjects")(function* (
    projectId?: GitHubIssueListInput["projectId"],
  ) {
    const snapshot = yield* projections.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new GitHubIssueOperationErrorClass({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause,
          }),
      ),
    );
    const seen = new Set<string>();
    const projects: GitHubProject[] = [];
    for (const project of snapshot.projects) {
      // Apply the logical-project filter before physical-repository de-duplication. Otherwise a
      // duplicate earlier in the snapshot can hide the project the caller explicitly selected.
      if (projectId !== undefined && project.id !== projectId) continue;
      if (project.repositoryIdentity?.provider !== "github") continue;
      const repository = repositoryIdentityOf(project);
      if (repository === null) continue;
      const host = pullRequestHostOf(project.repositoryIdentity, "github");
      const key = `${host}/${repository}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({ project, repository, host });
    }
    return projects;
  });

  const list: GitHubIssueService["Service"]["list"] = Effect.fn("GitHubIssueService.list")(
    function* (input) {
      const projects = yield* workspaceProjects(input.projectId);
      const limit = input.limit ?? DEFAULT_LIMIT;
      const search = [input.query, "sort:updated-desc"].filter(Boolean).join(" ");
      // A missing CLI escapes the concurrent traversal, intentionally discarding partial batches.
      const batches = yield* Effect.forEach(
        projects,
        (project) =>
          cli
            .execute({
              cwd: project.project.workspaceRoot,
              args: [
                "issue",
                "list",
                "--repo",
                cliRepository(project),
                "--state",
                input.state,
                "--limit",
                String(limit + 1),
                "--json",
                ISSUE_LIST_FIELDS,
                "--search",
                search,
              ],
            })
            .pipe(
              Effect.mapError(fromCliError("list", project.host)),
              Effect.flatMap((output) =>
                decodeGitHubIssueList(output.stdout).pipe(
                  Effect.mapError((cause) => decodeError("list", cause)),
                ),
              ),
              Effect.map((issues) => ({ project, issues })),
              Effect.catchTags({
                GitHubIssueCliUnauthenticatedError: (error) =>
                  Effect.succeed({ project, error } satisfies GitHubIssueProjectFailure),
                GitHubIssueOperationError: (error) =>
                  Effect.succeed({ project, error } satisfies GitHubIssueProjectFailure),
              }),
            ),
        { concurrency: PROJECT_CONCURRENCY },
      );

      const entries: GitHubIssueListEntry[] = [];
      const errors: GitHubIssueListResult["errors"][number][] = [];
      let truncated = false;
      for (const batch of batches) {
        if ("error" in batch) {
          errors.push({
            projectId: batch.project.project.id,
            projectTitle: batch.project.project.title,
            message:
              batch.error._tag === "GitHubIssueCliUnauthenticatedError"
                ? `${batch.project.repository} needs GitHub CLI authentication. Run \`${authCommandForHost(batch.project.host)}\` and retry.`
                : `${batch.project.repository} could not be read: ${batch.error.detail}`,
          });
          continue;
        }
        truncated ||= batch.issues.length > limit;
        for (const issue of batch.issues.slice(0, limit)) {
          entries.push({
            ...issue,
            projectId: batch.project.project.id,
            projectTitle: batch.project.project.title,
            repository: batch.project.repository,
          });
        }
      }
      const sortedEntries = entries.toSorted(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      );
      truncated ||= sortedEntries.length > limit;
      return { entries: sortedEntries.slice(0, limit), errors, truncated };
    },
  );

  const detail: GitHubIssueService["Service"]["detail"] = Effect.fn("GitHubIssueService.detail")(
    function* (input) {
      const projects = yield* workspaceProjects(input.projectId);
      const project = projects[0];
      if (project === undefined) {
        return yield* new GitHubIssueOperationErrorClass({
          operation: "detail",
          detail: "The selected project cannot read GitHub issues.",
        });
      }
      const output = yield* cli
        .execute({
          cwd: project.project.workspaceRoot,
          args: [
            "issue",
            "view",
            String(input.number),
            "--repo",
            cliRepository(project, input.repository),
            "--json",
            ISSUE_DETAIL_FIELDS,
          ],
        })
        .pipe(Effect.mapError(fromCliError("detail", project.host)));
      const issue = yield* decodeGitHubIssueDetail(output.stdout).pipe(
        Effect.mapError((cause) => decodeError("detail", cause)),
      );
      return {
        ...issue,
        comments: issue.comments.slice(-DETAIL_COMMENT_LIMIT),
        projectId: project.project.id,
        projectTitle: project.project.title,
        workspaceRoot: project.project.workspaceRoot,
        repository: input.repository,
        commentCount: issue.comments.length,
      };
    },
  );

  return GitHubIssueService.of({ list, detail });
});

export const layer = Layer.effect(GitHubIssueService, make);
