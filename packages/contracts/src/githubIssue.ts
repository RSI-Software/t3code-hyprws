import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const GitHubIssueState = Schema.Literals(["open", "closed"]);
export type GitHubIssueState = typeof GitHubIssueState.Type;

export const GitHubIssueListState = Schema.Literals(["all", "open", "closed"]);
export type GitHubIssueListState = typeof GitHubIssueListState.Type;

export const GitHubIssueActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type GitHubIssueActor = typeof GitHubIssueActor.Type;

export const GitHubIssueLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type GitHubIssueLabel = typeof GitHubIssueLabel.Type;

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
  state: GitHubIssueState,
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

export const GitHubIssueListEntry = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(GitHubIssueActor),
  assignees: Schema.Array(GitHubIssueActor),
  labels: Schema.Array(GitHubIssueLabel),
  // Optional, not merely nullable: a client merges lists from several environments at once, and an
  // environment on an older server omits the key entirely rather than sending null.
  issueType: Schema.optional(Schema.NullOr(GitHubIssueType)),
  state: GitHubIssueState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  // Optional for the same reason `issueType` is: an environment on an older server omits the key.
  commentCount: Schema.optional(NonNegativeInt),
  reactions: Schema.optional(GitHubIssueReactions),
});
export type GitHubIssueListEntry = typeof GitHubIssueListEntry.Type;

export const GitHubIssueListInput = Schema.Struct({
  state: GitHubIssueListState,
  projectId: Schema.optional(ProjectId),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type GitHubIssueListInput = typeof GitHubIssueListInput.Type;

export const GitHubIssueListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type GitHubIssueListProjectError = typeof GitHubIssueListProjectError.Type;

export const GitHubIssueListResult = Schema.Struct({
  entries: Schema.Array(GitHubIssueListEntry),
  errors: Schema.Array(GitHubIssueListProjectError),
  truncated: Schema.Boolean,
});
export type GitHubIssueListResult = typeof GitHubIssueListResult.Type;

export const GitHubIssueRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type GitHubIssueRef = typeof GitHubIssueRef.Type;

export const GitHubIssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(GitHubIssueActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  url: TrimmedNonEmptyString,
});
export type GitHubIssueComment = typeof GitHubIssueComment.Type;

export const GitHubIssueDetail = Schema.Struct({
  ...GitHubIssueListEntry.fields,
  workspaceRoot: TrimmedNonEmptyString,
  body: Schema.String,
  comments: Schema.Array(GitHubIssueComment),
  commentCount: NonNegativeInt,
  // Optional for the same reason `issueType` is: an older environment omits the key.
  subIssues: Schema.optional(Schema.Array(GitHubSubIssue)),
  closedAt: Schema.NullOr(IsoDateTime),
});
export type GitHubIssueDetail = typeof GitHubIssueDetail.Type;

export class GitHubIssueCliMissingError extends Schema.TaggedErrorClass<GitHubIssueCliMissingError>()(
  "GitHubIssueCliMissingError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "GitHub CLI (`gh`) is required to browse issues. Install it from https://cli.github.com/ and reload.";
  }
}

export class GitHubIssueCliUnauthenticatedError extends Schema.TaggedErrorClass<GitHubIssueCliUnauthenticatedError>()(
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

export class GitHubIssueOperationError extends Schema.TaggedErrorClass<GitHubIssueOperationError>()(
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
