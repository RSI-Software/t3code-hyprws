import {
  GitHubIssueActor,
  GitHubIssueComment,
  GitHubIssueLabel,
  GitHubIssueState,
  IsoDateTime,
  PositiveInt,
  TrimmedNonEmptyString,
  type GitHubIssueActor as GitHubIssueActorType,
  type GitHubIssueComment as GitHubIssueCommentType,
  type GitHubIssueLabel as GitHubIssueLabelType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const RawActor = Schema.Struct({
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawComment = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(RawActor),
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.optional(Schema.String),
  url: Schema.String,
});

const RawIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  author: Schema.NullOr(RawActor),
  assignees: Schema.Array(RawActor),
  labels: Schema.Array(RawLabel),
  state: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  body: Schema.optional(Schema.String),
  comments: Schema.optional(Schema.Array(RawComment)),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const NormalizedIssue = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(GitHubIssueActor),
  assignees: Schema.Array(GitHubIssueActor),
  labels: Schema.Array(GitHubIssueLabel),
  state: GitHubIssueState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const NormalizedIssueDetail = Schema.Struct({
  ...NormalizedIssue.fields,
  body: Schema.String,
  comments: Schema.Array(GitHubIssueComment),
  closedAt: Schema.NullOr(IsoDateTime),
});

const decodeIssueList = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(RawIssue)));
const decodeIssueDetail = Schema.decodeEffect(Schema.fromJsonString(RawIssue));
const decodeNormalizedIssueList = Schema.decodeUnknownEffect(Schema.Array(NormalizedIssue));
const decodeNormalizedIssueDetail = Schema.decodeUnknownEffect(NormalizedIssueDetail);

type RawActor = typeof RawActor.Type;
type RawLabel = typeof RawLabel.Type;
type RawComment = typeof RawComment.Type;
export type RawGitHubIssue = typeof RawIssue.Type;

function actor(raw: RawActor): GitHubIssueActorType | null {
  const login = raw.login.trim();
  if (login.length === 0) return null;
  return {
    login,
    name: raw.name ?? null,
    avatarUrl: raw.avatarUrl ?? null,
  };
}

function label(raw: RawLabel): GitHubIssueLabelType {
  return { name: raw.name, color: raw.color ?? null };
}

function state(raw: string): string {
  return raw.toLowerCase();
}

function timestamp(raw: string): string {
  if (!Number.isFinite(Date.parse(raw))) throw new Error(`Invalid GitHub timestamp: ${raw}`);
  return raw;
}

export function normalizeGitHubIssue(raw: RawGitHubIssue) {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author === null ? null : actor(raw.author),
    assignees: raw.assignees.flatMap((assignee) => actor(assignee) ?? []),
    labels: raw.labels.map(label),
    state: state(raw.state),
    createdAt: timestamp(raw.createdAt),
    updatedAt: timestamp(raw.updatedAt),
  };
}

function comment(raw: RawComment): GitHubIssueCommentType {
  return {
    id: raw.id,
    author: raw.author === null ? null : actor(raw.author),
    body: raw.body,
    createdAt: timestamp(raw.createdAt),
    // `gh issue view --json comments` omits `updatedAt`; an unedited comment's creation time is
    // the only timestamp available from this command.
    updatedAt: timestamp(raw.updatedAt ?? raw.createdAt),
    url: raw.url,
  };
}

export const decodeGitHubIssueList = Effect.fn("decodeGitHubIssueList")(function* (raw: string) {
  const decoded = yield* decodeIssueList(raw);
  const normalized = yield* Effect.try(() => decoded.map(normalizeGitHubIssue));
  return yield* decodeNormalizedIssueList(normalized);
});

export const decodeGitHubIssueDetail = Effect.fn("decodeGitHubIssueDetail")(function* (
  raw: string,
) {
  const decoded = yield* decodeIssueDetail(raw);
  const normalized = yield* Effect.try(() => ({
    ...normalizeGitHubIssue(decoded),
    body: decoded.body ?? "",
    comments: (decoded.comments ?? []).map(comment),
    closedAt:
      decoded.closedAt === null || decoded.closedAt === undefined
        ? null
        : timestamp(decoded.closedAt),
  }));
  return yield* decodeNormalizedIssueDetail(normalized);
});
