import type {
  GitHubIssueCliMissingError,
  GitHubIssueCliUnauthenticatedError,
  GitHubIssueDetail,
  GitHubIssueListEntry,
  GitHubIssueListInput,
  GitHubIssueListResult,
  GitHubIssueOperationError,
  GitHubIssueRef,
  GitHubIssueSetStateInput,
  OrchestrationProjectShell,
} from "@t3tools/contracts";
import {
  GitHubIssueCliMissingError as GitHubIssueCliMissingErrorClass,
  GitHubIssueCliUnauthenticatedError as GitHubIssueCliUnauthenticatedErrorClass,
  GitHubIssueOperationError as GitHubIssueOperationErrorClass,
  pullRequestHostOf,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import {
  decodeParsedGitHubIssueDetail,
  decodeParsedGitHubIssueList,
  decodeParsedGitHubIssueSummary,
  type GitHubIssueSummary,
} from "./gitHubIssueJson.ts";
import { attachSubIssueCloseReasons } from "./subIssueCloseReasons.fork.ts";

const DEFAULT_LIMIT = 50;
const PROJECT_CONCURRENCY = 8;
/** The detail read keeps the newest comments only; the GraphQL window matches that slice. */
const DETAIL_COMMENT_LIMIT = 100;
// GitHub caps a GraphQL search page at 100 nodes; the +1 that detects truncation stays under it.
const SEARCH_PAGE_MAX = 100;

/**
 * The issue fields the panels read, selected from GitHub's GraphQL schema. Actor unions expose
 * `login` everywhere and a real name only on some members, so `name` and `avatarUrl` sit inside
 * member fragments: an absent key decodes as the null the wire contract allows, and a future
 * union member cannot fail the whole read.
 */
const ISSUE_ACTOR_SELECTION =
  "login ... on User { name avatarUrl } ... on Organization { name avatarUrl }";
const ISSUE_BASE_SELECTION = `number title url author { ${ISSUE_ACTOR_SELECTION} } assignees(first: 100) { nodes { login name avatarUrl } } labels(first: 100) { nodes { name color } } issueType { name color } state stateReason createdAt updatedAt reactionGroups { content users { totalCount } }`;
const ISSUE_SUMMARY_SELECTION = "title state stateReason";
const ISSUE_DETAIL_SELECTION = `${ISSUE_BASE_SELECTION} body subIssues(first: 100) { nodes { number title url state stateReason } } closedAt comments(last: ${DETAIL_COMMENT_LIMIT}) { totalCount nodes { id author { ${ISSUE_ACTOR_SELECTION} } body createdAt updatedAt url } }`;

const ISSUE_SEARCH_QUERY = `query($query:String!,$first:Int!){search(query:$query,type:ISSUE,first:$first){nodes{... on Issue{${ISSUE_BASE_SELECTION} comments{totalCount}}}}}`;
const ISSUE_DETAIL_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${ISSUE_DETAIL_SELECTION}}}}`;
const ISSUE_SUMMARY_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${ISSUE_SUMMARY_SELECTION}}}}`;
const ISSUE_ID_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}`;
const CLOSE_ISSUE_MUTATION = `mutation($issueId:ID!,$stateReason:IssueCloseReason){closeIssue(input:{issueId:$issueId,stateReason:$stateReason}){issue{id}}}`;
const REOPEN_ISSUE_MUTATION = `mutation($issueId:ID!){reopenIssue(input:{issueId:$issueId}){issue{id}}}`;

/**
 * One issue row as GitHub's GraphQL schema answers it. Connections stay structured while the
 * row's inner objects pass through untouched: the issue decoders own their contents, and
 * `Schema.Struct` would silently drop the optional keys (`name`, `color`, …) the fragments ask for.
 */
const GraphQlIssueRow = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  author: Schema.NullOr(Schema.Unknown),
  assignees: Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }),
  labels: Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }),
  issueType: Schema.NullOr(Schema.Unknown),
  state: Schema.String,
  stateReason: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  reactionGroups: Schema.NullOr(Schema.Array(Schema.Unknown)),
  body: Schema.optional(Schema.String),
  subIssues: Schema.optional(Schema.Struct({ nodes: Schema.Array(Schema.Unknown) })),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(
    Schema.Struct({
      totalCount: Schema.Number,
      nodes: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
});
type GraphQlIssueRowType = Schema.Schema.Type<typeof GraphQlIssueRow>;

const SearchEnvelope = Schema.Struct({
  data: Schema.Struct({ search: Schema.Struct({ nodes: Schema.Array(GraphQlIssueRow) }) }),
});
const DetailEnvelope = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(Schema.Struct({ issue: Schema.NullOr(GraphQlIssueRow) })),
  }),
});
const SummaryEnvelope = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        issue: Schema.NullOr(
          Schema.Struct({
            title: Schema.String,
            state: Schema.String,
            stateReason: Schema.NullOr(Schema.String),
          }),
        ),
      }),
    ),
  }),
});
const IssueIdEnvelope = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({ issue: Schema.NullOr(Schema.Struct({ id: Schema.String })) }),
    ),
  }),
});
const MutationEnvelope = Schema.Struct({
  data: Schema.Struct({
    closeIssue: Schema.optional(
      Schema.NullOr(Schema.Struct({ issue: Schema.Struct({ id: Schema.String }) })),
    ),
    reopenIssue: Schema.optional(
      Schema.NullOr(Schema.Struct({ issue: Schema.Struct({ id: Schema.String }) })),
    ),
  }),
});

const decodeSearchEnvelope = Schema.decodeSync(Schema.fromJsonString(SearchEnvelope));
const decodeDetailEnvelope = Schema.decodeSync(Schema.fromJsonString(DetailEnvelope));
const decodeSummaryEnvelope = Schema.decodeSync(Schema.fromJsonString(SummaryEnvelope));
const decodeIssueIdEnvelope = Schema.decodeSync(Schema.fromJsonString(IssueIdEnvelope));
const decodeMutationEnvelope = Schema.decodeSync(Schema.fromJsonString(MutationEnvelope));

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
    readonly summary: (
      input: GitHubIssueRef,
    ) => Effect.Effect<GitHubIssueSummary, GitHubIssueError>;
    readonly setState: (input: GitHubIssueSetStateInput) => Effect.Effect<void, GitHubIssueError>;
  }
>()("t3/githubIssue/GitHubIssueService") {}

function authCommandForHost(host: string): string {
  return host === "github.com" ? "gh auth login" : `gh auth login --hostname ${host}`;
}

function fromApiError(operation: string, host: string) {
  return (error: GitHubApi.GitHubApiError): GitHubIssueError => {
    // No credential at all is the missing-binary world's "nothing to authenticate with": the
    // whole read fails rather than degrading, the way a missing `gh` once did.
    if (error._tag === "GitHubCliMissingError") {
      return new GitHubIssueCliMissingErrorClass({ cause: error });
    }
    if (
      error._tag === "GitHubApiAuthenticationError" ||
      error._tag === "GitHubNotSignedInError" ||
      error._tag === "GitHubHostDisabledError"
    ) {
      return new GitHubIssueCliUnauthenticatedErrorClass({ host, cause: error });
    }
    return new GitHubIssueOperationErrorClass({ operation, detail: error.message, cause: error });
  };
}

function decodeError(operation: string, cause: unknown): GitHubIssueOperationError {
  return new GitHubIssueOperationErrorClass({
    operation,
    detail: "GitHub returned unreadable issue data.",
    cause,
  });
}

/** Reshapes one GraphQL issue row into the flat shape the issue decoders already speak. */
function toRawIssue(row: GraphQlIssueRowType): Record<string, unknown> {
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author,
    assignees: row.assignees.nodes,
    labels: row.labels.nodes,
    issueType: row.issueType,
    state: row.state,
    stateReason: row.stateReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reactionGroups: row.reactionGroups,
    ...(row.body === undefined ? {} : { body: row.body }),
    ...(row.subIssues === undefined ? {} : { subIssues: row.subIssues }),
    ...(row.closedAt === undefined ? {} : { closedAt: row.closedAt }),
    // A list row asks for the count alone; a detail row carries the newest window's nodes.
    ...(row.comments === undefined ? {} : { comments: row.comments.nodes ?? [] }),
  };
}

export const make = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const projectService = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  const workspaceProjects = Effect.fn("GitHubIssueService.workspaceProjects")(function* (
    projectId?: GitHubIssueListInput["projectId"],
  ) {
    const shells = yield* (
      projectId === undefined
        ? projectService.listShells()
        : projectService.getShell(projectId).pipe(Effect.map(Option.toArray))
    ).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubIssueOperationErrorClass({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause,
          }),
      ),
    );
    // A shell resolves its repository in the background; an issue read cannot wait for that.
    const resolved = yield* Effect.forEach(
      shells,
      (project) =>
        project.repositoryIdentity != null
          ? Effect.succeed(project)
          : repositoryIdentities
              .resolve(project.workspaceRoot)
              .pipe(Effect.map((repositoryIdentity) => ({ ...project, repositoryIdentity }))),
      { concurrency: PROJECT_CONCURRENCY },
    );
    const seen = new Set<string>();
    const projects: GitHubProject[] = [];
    for (const project of resolved) {
      // Apply the logical-project filter before physical-repository de-duplication. Otherwise a
      // duplicate earlier in the snapshot can hide the project the caller explicitly selected.
      if (projectId !== undefined && project.id !== projectId) continue;
      if (project.repositoryIdentity?.provider !== "github") continue;
      const repository = sourceControlRepositorySelector(project.repositoryIdentity);
      if (repository === null) continue;
      const host = pullRequestHostOf(project.repositoryIdentity, "github");
      const key = `${host}/${repository}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({ project, repository, host });
    }
    return projects;
  });

  /**
   * The search a repository's list asks for. The host picks the API endpoint, so the `repo:`
   * qualifier stays `OWNER/REPO`; a host-qualified one matches nothing.
   */
  const searchQueryFor = (project: GitHubProject, input: GitHubIssueListInput): string =>
    [
      `repo:${project.repository}`,
      "is:issue",
      ...(input.state === "all" ? [] : [`state:${input.state}`]),
      ...(input.query === undefined ? [] : [input.query]),
      "sort:updated-desc",
    ].join(" ");

  /** One repository's search page, decoded, with each row's true comment count beside it. */
  const readSearchRows = Effect.fn("GitHubIssueService.readSearchRows")(function* (input: {
    readonly project: GitHubProject;
    readonly listInput: GitHubIssueListInput;
    readonly limit: number;
  }) {
    const body = yield* api
      .graphql({
        host: input.project.host,
        operation: "listIssues",
        query: ISSUE_SEARCH_QUERY,
        variables: {
          query: searchQueryFor(input.project, input.listInput),
          first: Math.min(input.limit + 1, SEARCH_PAGE_MAX),
        },
      })
      .pipe(Effect.mapError(fromApiError("list", input.project.host)));
    const parsed = yield* Effect.try(() => decodeSearchEnvelope(body)).pipe(
      Effect.mapError((cause) => decodeError("list", cause)),
    );
    const rows = parsed.data.search.nodes;
    const issues = yield* decodeParsedGitHubIssueList(rows.map(toRawIssue)).pipe(
      Effect.mapError((cause) => decodeError("list", cause)),
    );
    return { issues, commentCounts: rows.map((row) => row.comments?.totalCount ?? 0) };
  });

  const list: GitHubIssueService["Service"]["list"] = Effect.fn("GitHubIssueService.list")(
    function* (input) {
      const projects = yield* workspaceProjects(input.projectId);
      const limit = input.limit ?? DEFAULT_LIMIT;
      // A missing credential escapes the concurrent traversal, intentionally discarding partial batches.
      const batches = yield* Effect.forEach(
        projects,
        (project) =>
          readSearchRows({ project, listInput: input, limit }).pipe(
            Effect.map((read) => ({ project, ...read })),
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
        for (const [index, issue] of batch.issues.slice(0, limit).entries()) {
          entries.push({
            ...issue,
            commentCount: batch.commentCounts[index] ?? issue.commentCount,
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

  /** The project an issue reference names, which is the repository the API reads. */
  const issueProject = Effect.fn("GitHubIssueService.issueProject")(function* (
    input: GitHubIssueRef,
    operation: string,
  ) {
    const projects = yield* workspaceProjects(input.projectId);
    const project = projects[0];
    if (project === undefined) {
      return yield* new GitHubIssueOperationErrorClass({
        operation,
        detail: "The selected project cannot read GitHub issues.",
      });
    }
    return project;
  });

  const readIssueRow = <A>(
    input: {
      readonly project: GitHubProject;
      readonly ref: GitHubIssueRef;
      readonly operation: string;
      readonly query: string;
    },
    decodeEnvelope: (body: string) => { data: { repository: { issue: A | null } | null } },
  ): Effect.Effect<A, GitHubIssueError> =>
    api
      .graphql({
        host: input.project.host,
        operation: input.operation,
        query: input.query,
        variables: {
          owner: input.ref.repository.split("/")[0] ?? "",
          name: input.ref.repository.split("/")[1] ?? "",
          number: input.ref.number,
        },
      })
      .pipe(
        Effect.mapError(fromApiError(input.operation, input.project.host)),
        Effect.flatMap((body) =>
          Effect.try(() => decodeEnvelope(body)).pipe(
            Effect.mapError((cause) => decodeError(input.operation, cause)),
          ),
        ),
        Effect.flatMap((parsed) => {
          const issue = parsed.data.repository?.issue;
          return issue === null || issue === undefined
            ? Effect.fail(
                new GitHubIssueOperationErrorClass({
                  operation: input.operation,
                  detail: `Issue #${input.ref.number} was not found in ${input.ref.repository}.`,
                }),
              )
            : Effect.succeed(issue);
        }),
      );

  const detail: GitHubIssueService["Service"]["detail"] = Effect.fn("GitHubIssueService.detail")(
    function* (input) {
      const project = yield* issueProject(input, "detail");
      const row = yield* readIssueRow(
        { project, ref: input, operation: "detail", query: ISSUE_DETAIL_QUERY },
        decodeDetailEnvelope,
      );
      const issue = yield* decodeParsedGitHubIssueDetail(toRawIssue(row)).pipe(
        Effect.mapError((cause) => decodeError("detail", cause)),
      );
      // Fork-hook: github-issues/sub-issue-close-reasons — the detail read omits a child's close
      // reason, so one extra read attaches it when a closed child exists
      // (RSI-Software/t3code-hyprws#1461).
      const subIssues = yield* attachSubIssueCloseReasons(api, {
        host: project.host,
        repository: input.repository,
        parentNumber: input.number,
        children: issue.subIssues,
      });
      return {
        ...issue,
        subIssues,
        // The window is the read itself (`last: 100`); totalCount keeps the true count.
        comments: issue.comments,
        commentCount: row.comments?.totalCount ?? issue.comments.length,
        projectId: project.project.id,
        projectTitle: project.project.title,
        workspaceRoot: project.project.workspaceRoot,
        repository: input.repository,
      };
    },
  );

  const summary: GitHubIssueService["Service"]["summary"] = Effect.fn("GitHubIssueService.summary")(
    function* (input) {
      const project = yield* issueProject(input, "summary");
      const row = yield* readIssueRow(
        { project, ref: input, operation: "summary", query: ISSUE_SUMMARY_QUERY },
        decodeSummaryEnvelope,
      );
      return yield* decodeParsedGitHubIssueSummary({
        title: row.title,
        state: row.state,
        stateReason: row.stateReason,
      }).pipe(Effect.mapError((cause) => decodeError("summary", cause)));
    },
  );

  const setState: GitHubIssueService["Service"]["setState"] = Effect.fn(
    "GitHubIssueService.setState",
  )(function* (input) {
    const operation = input.state === "closed" ? "close" : "reopen";
    const project = yield* issueProject(input, operation);
    // The node id is read first, then the mutation runs on it. GitHub's mutations answer a
    // repeat of the state the issue already has with the issue itself and no error, so a press
    // that raced another reader's settles on the state asked for either way.
    const idBody = yield* api
      .graphql({
        host: project.host,
        operation: `${operation}IssueId`,
        query: ISSUE_ID_QUERY,
        variables: {
          owner: input.repository.split("/")[0] ?? "",
          name: input.repository.split("/")[1] ?? "",
          number: input.number,
        },
      })
      .pipe(Effect.mapError(fromApiError(operation, project.host)));
    const parsed = yield* Effect.try(() => decodeIssueIdEnvelope(idBody)).pipe(
      Effect.mapError((cause) => decodeError(operation, cause)),
    );
    const issueId = parsed.data.repository?.issue?.id;
    if (issueId === null || issueId === undefined) {
      return yield* new GitHubIssueOperationErrorClass({
        operation,
        detail: `Issue #${input.number} was not found in ${input.repository}.`,
      });
    }
    const mutationBody = yield* api
      .graphql({
        host: project.host,
        operation,
        query: input.state === "closed" ? CLOSE_ISSUE_MUTATION : REOPEN_ISSUE_MUTATION,
        variables:
          input.state === "closed"
            ? {
                issueId,
                // GitHub's GraphQL spelling of the close reason the wire contract names.
                stateReason: input.reason === "not planned" ? "NOT_PLANNED" : "COMPLETED",
              }
            : { issueId },
      })
      .pipe(Effect.mapError(fromApiError(operation, project.host)));
    const mutation = yield* Effect.try(() => decodeMutationEnvelope(mutationBody)).pipe(
      Effect.mapError((cause) => decodeError(operation, cause)),
    );
    const confirmed =
      input.state === "closed" ? mutation.data.closeIssue : mutation.data.reopenIssue;
    if (confirmed == null) {
      return yield* new GitHubIssueOperationErrorClass({
        operation,
        detail: `GitHub did not confirm the ${operation} of issue #${input.number}.`,
      });
    }
  });

  return GitHubIssueService.of({ list, detail, summary, setState });
});

export const layer = Layer.effect(GitHubIssueService, make);
