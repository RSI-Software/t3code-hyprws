import {
  IssueActor,
  IssueCloseReason,
  IssueComment,
  IssueLabel,
  GitHubIssueReactions,
  IssueState,
  GitHubIssueType,
  GitHubSubIssue,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type IssueActor as IssueActorType,
  type IssueCloseReason as IssueCloseReasonType,
  type IssueComment as IssueCommentType,
  type IssueLabel as IssueLabelType,
  type GitHubIssueReactions as GitHubIssueReactionsType,
  type GitHubIssueType as GitHubIssueTypeType,
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

const RawIssueType = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawSubIssue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  // A close reason in GitHub's GraphQL words; a read that does not select it leaves it absent.
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReactionGroup = Schema.Struct({
  content: Schema.String,
  users: Schema.optional(Schema.NullOr(Schema.Struct({ totalCount: Schema.Number }))),
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
  // `gh` only emits these two on a host that has issue types and sub-issues turned on, and older
  // CLIs omit them entirely, so both stay optional rather than failing a whole project's batch.
  issueType: Schema.optional(Schema.NullOr(RawIssueType)),
  subIssues: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawSubIssue) }))),
  parent: Schema.optional(Schema.NullOr(RawSubIssue)),
  state: Schema.String,
  // A close reason in GitHub's GraphQL words; gh versions before it asked for `stateReason` omit
  // the key entirely, which an absent reason must survive.
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  reactionGroups: Schema.optional(Schema.NullOr(Schema.Array(RawReactionGroup))),
  body: Schema.optional(Schema.String),
  comments: Schema.optional(Schema.Array(RawComment)),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const NormalizedIssue = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(IssueActor),
  assignees: Schema.Array(IssueActor),
  labels: Schema.Array(IssueLabel),
  issueType: Schema.NullOr(GitHubIssueType),
  state: IssueState,
  closeReason: Schema.NullOr(IssueCloseReason),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  commentCount: NonNegativeInt,
  reactions: GitHubIssueReactions,
});

const NormalizedIssueDetail = Schema.Struct({
  ...NormalizedIssue.fields,
  body: Schema.String,
  comments: Schema.Array(IssueComment),
  subIssues: Schema.Array(GitHubSubIssue),
  parent: Schema.NullOr(GitHubSubIssue),
  closedAt: Schema.NullOr(IsoDateTime),
});

const decodeUnknownIssueList = Schema.decodeUnknownEffect(Schema.Array(RawIssue));
const decodeUnknownIssueDetail = Schema.decodeUnknownEffect(RawIssue);
const decodeNormalizedIssueList = Schema.decodeUnknownEffect(Schema.Array(NormalizedIssue));
const decodeNormalizedIssueDetail = Schema.decodeUnknownEffect(NormalizedIssueDetail);

type RawActor = typeof RawActor.Type;
type RawLabel = typeof RawLabel.Type;
type RawComment = typeof RawComment.Type;
type RawIssueType = typeof RawIssueType.Type;
type RawSubIssue = typeof RawSubIssue.Type;
type RawReactionGroup = typeof RawReactionGroup.Type;
export type RawGitHubIssue = typeof RawIssue.Type;

function actor(raw: RawActor): IssueActorType | null {
  const login = raw.login.trim();
  if (login.length === 0) return null;
  return {
    login,
    name: raw.name ?? null,
    avatarUrl: raw.avatarUrl ?? null,
  };
}

function label(raw: RawLabel): IssueLabelType {
  return { name: raw.name, color: raw.color ?? null };
}

function issueType(raw: RawIssueType): GitHubIssueTypeType | null {
  const name = raw.name.trim();
  if (name.length === 0) return null;
  return { name, color: raw.color ?? null };
}

/**
 * The halves a reader sorts by. `CONFUSED` and `EYES` say "I am here", not "yes" or "no", so they
 * belong to neither total and would only blur an ordering built on agreement.
 */
const POSITIVE_REACTIONS = new Set(["THUMBS_UP", "HEART", "HOORAY", "ROCKET", "LAUGH"]);
const NEGATIVE_REACTIONS = new Set(["THUMBS_DOWN"]);

function reactions(
  groups: ReadonlyArray<RawReactionGroup> | null | undefined,
): GitHubIssueReactionsType {
  let positive = 0;
  let negative = 0;
  for (const group of groups ?? []) {
    const count = group.users?.totalCount ?? 0;
    if (POSITIVE_REACTIONS.has(group.content)) positive += count;
    else if (NEGATIVE_REACTIONS.has(group.content)) negative += count;
  }
  return { positive, negative };
}

function subIssue(raw: RawSubIssue) {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: state(raw.state),
    closeReason: closeReason(raw.stateReason),
  };
}

function state(raw: string): string {
  return raw.toLowerCase();
}

/**
 * A close reason in the wire's own words. An open issue, one reopened since its last close
 * (`REOPENED`), and anything a future GitHub adds all read as none rather than as a guess.
 */
function closeReason(raw: string | null | undefined): IssueCloseReasonType | null {
  if (raw === "COMPLETED") return "completed";
  if (raw === "NOT_PLANNED") return "not planned";
  return null;
}

function timestamp(raw: string): string {
  if (!Number.isFinite(Date.parse(raw))) throw new Error(`Invalid GitHub timestamp: ${raw}`);
  return raw;
}

function normalizeIssue(raw: RawGitHubIssue) {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author === null ? null : actor(raw.author),
    assignees: raw.assignees.flatMap((assignee) => actor(assignee) ?? []),
    labels: raw.labels.map(label),
    issueType:
      raw.issueType === null || raw.issueType === undefined ? null : issueType(raw.issueType),
    state: state(raw.state),
    closeReason: closeReason(raw.stateReason),
    createdAt: timestamp(raw.createdAt),
    updatedAt: timestamp(raw.updatedAt),
    // `gh` sends the comments themselves and no count; the list keeps only the count, so a busy
    // issue costs one number on the wire rather than every body it has collected.
    commentCount: (raw.comments ?? []).length,
    reactions: reactions(raw.reactionGroups),
  };
}

function comment(raw: RawComment): IssueCommentType {
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

function normalizeIssueDetail(decoded: RawGitHubIssue) {
  return {
    ...normalizeIssue(decoded),
    body: decoded.body ?? "",
    comments: (decoded.comments ?? []).map(comment),
    subIssues: (decoded.subIssues?.nodes ?? []).map(subIssue),
    parent: decoded.parent == null ? null : subIssue(decoded.parent),
    closedAt:
      decoded.closedAt === null || decoded.closedAt === undefined
        ? null
        : timestamp(decoded.closedAt),
  };
}

/** A row the schema accepted but normalization could not reshape. */
class GitHubIssueNormalizeError extends Schema.TaggedError<GitHubIssueNormalizeError>()(
  "GitHubIssueNormalizeError",
  { cause: Schema.Defect() },
) {}

export const decodeParsedGitHubIssueList = Effect.fn("decodeParsedGitHubIssueList")(function* (
  rows: ReadonlyArray<unknown>,
) {
  const decoded = yield* decodeUnknownIssueList(rows);
  const normalized = yield* Effect.try({
    try: () => decoded.map(normalizeIssue),
    catch: (cause) => new GitHubIssueNormalizeError({ cause }),
  });
  return yield* decodeNormalizedIssueList(normalized);
});

export const decodeParsedGitHubIssueDetail = Effect.fn("decodeParsedGitHubIssueDetail")(function* (
  row: unknown,
) {
  const decoded = yield* decodeUnknownIssueDetail(row);
  return yield* decodeNormalizedIssueDetail(normalizeIssueDetail(decoded));
});

/** What a linked-issue snapshot stores, read on its own so a refresh skips the rest of a detail
 * read (RSI-Software/t3code-hyprws#1451). Server-local: nothing of it crosses the wire. */
const IssueSummary = Schema.Struct({
  title: TrimmedNonEmptyString,
  state: IssueState,
  closeReason: Schema.NullOr(IssueCloseReason),
  subIssues: Schema.optionalKey(Schema.Array(GitHubSubIssue)),
  parent: Schema.optionalKey(GitHubSubIssue),
  labels: Schema.optionalKey(Schema.Array(IssueLabel)),
  issueType: Schema.optionalKey(GitHubIssueType),
});
export type GitHubIssueSummary = typeof IssueSummary.Type;

const RawIssueSummary = Schema.Struct({
  title: Schema.String,
  state: Schema.String,
  stateReason: Schema.NullOr(Schema.String),
  subIssues: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawSubIssue) }))),
  parent: Schema.optional(Schema.NullOr(RawSubIssue)),
  labels: Schema.optional(Schema.NullOr(Schema.Struct({ nodes: Schema.Array(RawLabel) }))),
  issueType: Schema.optional(Schema.NullOr(RawIssueType)),
});

const decodeUnknownIssueSummary = Schema.decodeUnknownEffect(RawIssueSummary);
const decodeNormalizedIssueSummary = Schema.decodeUnknownEffect(IssueSummary);

/** A linked issue's summary, read from a row the caller already parsed. Empty keys are left out,
 * so a bare issue's snapshot keeps its earlier shape. */
export const decodeParsedGitHubIssueSummary = Effect.fn("decodeParsedGitHubIssueSummary")(
  function* (row: unknown) {
    const raw = yield* decodeUnknownIssueSummary(row);
    const subIssues = (raw.subIssues?.nodes ?? []).map(subIssue);
    const labels = (raw.labels?.nodes ?? []).map(label);
    const type = raw.issueType == null ? null : issueType(raw.issueType);
    return yield* decodeNormalizedIssueSummary({
      title: raw.title,
      state: state(raw.state),
      closeReason: closeReason(raw.stateReason),
      ...(subIssues.length === 0 ? {} : { subIssues }),
      ...(raw.parent == null ? {} : { parent: subIssue(raw.parent) }),
      ...(labels.length === 0 ? {} : { labels }),
      ...(type === null ? {} : { issueType: type }),
    });
  },
);
