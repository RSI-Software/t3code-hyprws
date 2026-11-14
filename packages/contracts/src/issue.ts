import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;

/** Why an issue closed, in `gh issue close --reason`'s words. */
export const IssueCloseReason = Schema.Literals(["completed", "not planned"]);
export type IssueCloseReason = typeof IssueCloseReason.Type;

export const IssueListState = Schema.Literals(["all", "open", "closed"]);
export type IssueListState = typeof IssueListState.Type;

export const IssueActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type IssueActor = typeof IssueActor.Type;

export const IssueLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type IssueLabel = typeof IssueLabel.Type;

/**
 * GitHub's native issue type, which is one per issue and separate from its labels. The colour is
 * an enum name such as `RED`, not the hex a label carries, so a client maps it before painting.
 */
export const GitHubIssueType = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type GitHubIssueType = typeof GitHubIssueType.Type;

/**
 * A child in GitHub's sub-issue hierarchy. A child may live in another repository, so the URL is
 * the only part a client can always trust to reach it.
 */
export const GitHubSubIssue = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: IssueState,
  // Optional, not merely nullable: a client merges details from several environments at once, and
  // an environment on an older server omits the key entirely rather than sending null.
  closeReason: Schema.optional(Schema.NullOr(IssueCloseReason)),
});
export type GitHubSubIssue = typeof GitHubSubIssue.Type;

/**
 * GitHub's eight reaction groups collapsed to the only question a reader sorts by: is the room for
 * this or against it. `CONFUSED` and `EYES` answer neither, so they are counted in neither half.
 */
export const GitHubIssueReactions = Schema.Struct({
  positive: NonNegativeInt,
  negative: NonNegativeInt,
});
export type GitHubIssueReactions = typeof GitHubIssueReactions.Type;

export const IssueListEntry = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(IssueActor),
  assignees: Schema.Array(IssueActor),
  labels: Schema.Array(IssueLabel),
  // Optional, not merely nullable: a client merges lists from several environments at once, and an
  // environment on an older server omits the key entirely rather than sending null.
  issueType: Schema.optional(Schema.NullOr(GitHubIssueType)),
  state: IssueState,
  // Optional for the same reason `issueType` is: an environment on an older server omits the key
  // entirely rather than sending null.
  closeReason: Schema.optional(Schema.NullOr(IssueCloseReason)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  // Optional for the same reason `issueType` is: an environment on an older server omits the key.
  commentCount: Schema.optional(NonNegativeInt),
  reactions: Schema.optional(GitHubIssueReactions),
});
export type IssueListEntry = typeof IssueListEntry.Type;

export const IssueListViewFork = Schema.Struct({
  order: Schema.Struct({
    sort: Schema.Literals([
      "created",
      "updated",
      "comments",
      "reactions-positive",
      "reactions-negative",
    ]),
    direction: Schema.Literals(["desc", "asc"]),
  }),
  filters: Schema.Array(
    Schema.Struct({
      field: Schema.Literals(["type", "label"]),
      operator: Schema.Literals(["is", "is-not"]),
      values: Schema.Array(TrimmedNonEmptyString),
    }),
  ),
});
export type IssueListViewFork = typeof IssueListViewFork.Type;

export const IssueListInput = Schema.Struct({
  state: IssueListState,
  projectId: Schema.optional(ProjectId),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  listViewFork: Schema.optional(IssueListViewFork),
});
export type IssueListInput = typeof IssueListInput.Type;

export const IssueListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type IssueListProjectError = typeof IssueListProjectError.Type;

export const IssueListResult = Schema.Struct({
  entries: Schema.Array(IssueListEntry),
  errors: Schema.Array(IssueListProjectError),
  truncated: Schema.Boolean,
});
export type IssueListResult = typeof IssueListResult.Type;

export const IssueRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type IssueRef = typeof IssueRef.Type;

/** Closes or reopens an issue. A reason only applies to a close; GitHub defaults it to completed. */
export const IssueSetStateInput = Schema.Struct({
  ...IssueRef.fields,
  state: IssueState,
  reason: Schema.optional(IssueCloseReason),
});
export type IssueSetStateInput = typeof IssueSetStateInput.Type;

export const IssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(IssueActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  url: TrimmedNonEmptyString,
});
export type IssueComment = typeof IssueComment.Type;

export const IssueDetail = Schema.Struct({
  ...IssueListEntry.fields,
  workspaceRoot: TrimmedNonEmptyString,
  body: Schema.String,
  comments: Schema.Array(IssueComment),
  commentCount: NonNegativeInt,
  // Optional for the same reason `issueType` is: an older environment omits the key.
  subIssues: Schema.optional(Schema.Array(GitHubSubIssue)),
  parent: Schema.optional(Schema.NullOr(GitHubSubIssue)),
  closedAt: Schema.NullOr(IsoDateTime),
});
export type IssueDetail = typeof IssueDetail.Type;

export class GitHubIssueCliMissingError extends Schema.TaggedError<GitHubIssueCliMissingError>()(
  "GitHubIssueCliMissingError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "GitHub CLI (`gh`) is required to browse issues. Install it from https://cli.github.com/ and reload.";
  }
}

export class GitHubIssueCliUnauthenticatedError extends Schema.TaggedError<GitHubIssueCliUnauthenticatedError>()(
  "GitHubIssueCliUnauthenticatedError",
  {
    cause: Schema.Defect(),
    host: Schema.optional(TrimmedNonEmptyString),
  },
) {
  override get message(): string {
    const loginCommand =
      this.host === undefined || this.host === "github.com"
        ? "gh auth login"
        : `gh auth login --hostname ${this.host}`;
    return `GitHub CLI is not authenticated. Run \`${loginCommand}\` and retry.`;
  }
}

export class GitHubIssueOperationError extends Schema.TaggedError<GitHubIssueOperationError>()(
  "GitHubIssueOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `GitHub issue operation ${this.operation} failed: ${this.detail}`;
  }
}
