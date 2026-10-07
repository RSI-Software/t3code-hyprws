import {
  GitHubIssueActor,
  GitHubIssueCloseReason,
  GitHubIssueComment,
  GitHubIssueLabel,
  GitHubIssueReactions,
  GitHubIssueState,
  GitHubIssueType,
  GitHubSubIssue,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type GitHubIssueActor as GitHubIssueActorType,
  type GitHubIssueCloseReason as GitHubIssueCloseReasonType,
  type GitHubIssueComment as GitHubIssueCommentType,
  type GitHubIssueLabel as GitHubIssueLabelType,
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
  // A close reason in GitHub's GraphQL words. `gh issue view --json subIssues` omits the key on
  // every child (gh 2.98.0), so a detail read attaches reasons with its own GraphQL call and an
  // absent key here must survive.
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
  author: Schema.NullOr(GitHubIssueActor),
  assignees: Schema.Array(GitHubIssueActor),
  labels: Schema.Array(GitHubIssueLabel),
  issueType: Schema.NullOr(GitHubIssueType),
  state: GitHubIssueState,
  closeReason: Schema.NullOr(GitHubIssueCloseReason),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  commentCount: NonNegativeInt,
  reactions: GitHubIssueReactions,
});

const NormalizedIssueDetail = Schema.Struct({
  ...NormalizedIssue.fields,
  body: Schema.String,
  comments: Schema.Array(GitHubIssueComment),
  subIssues: Schema.Array(GitHubSubIssue),
  closedAt: Schema.NullOr(IsoDateTime),
});

const decodeIssueList = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(RawIssue)));
const decodeIssueDetail = Schema.decodeEffect(Schema.fromJsonString(RawIssue));
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
function closeReason(raw: string | null | undefined): GitHubIssueCloseReasonType | null {
  if (raw === "COMPLETED") return "completed";
  if (raw === "NOT_PLANNED") return "not planned";
  return null;
}

function timestamp(raw: string): string {
  if (!Number.isFinite(Date.parse(raw))) throw new Error(`Invalid GitHub timestamp: ${raw}`);
  return raw;
}

function normalizeGitHubIssue(raw: RawGitHubIssue) {
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

function normalizeIssueDetail(decoded: RawGitHubIssue) {
  return {
    ...normalizeGitHubIssue(decoded),
    body: decoded.body ?? "",
    comments: (decoded.comments ?? []).map(comment),
    subIssues: (decoded.subIssues?.nodes ?? []).map(subIssue),
    closedAt:
      decoded.closedAt === null || decoded.closedAt === undefined
        ? null
        : timestamp(decoded.closedAt),
  };
}

export const decodeGitHubIssueList = Effect.fn("decodeGitHubIssueList")(function* (raw: string) {
  const decoded = yield* decodeIssueList(raw);
  const normalized = yield* Effect.try(() => decoded.map(normalizeGitHubIssue));
  return yield* decodeNormalizedIssueList(normalized);
});

/** The same read for rows that were never a JSON string, such as GraphQL answers reshaped in memory. */
export const decodeParsedGitHubIssueList = Effect.fn("decodeParsedGitHubIssueList")(function* (
  rows: ReadonlyArray<unknown>,
) {
  const decoded = yield* decodeUnknownIssueList(rows);
  const normalized = yield* Effect.try(() => decoded.map(normalizeGitHubIssue));
  return yield* decodeNormalizedIssueList(normalized);
});

export const decodeGitHubIssueDetail = Effect.fn("decodeGitHubIssueDetail")(function* (
  raw: string,
) {
  const decoded = yield* decodeIssueDetail(raw);
  return yield* decodeNormalizedIssueDetail(normalizeIssueDetail(decoded));
});

/** The same read for one row that was never a JSON string. */
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
  state: GitHubIssueState,
  closeReason: Schema.NullOr(GitHubIssueCloseReason),
});
export type GitHubIssueSummary = typeof IssueSummary.Type;

const decodeNormalizedIssueSummary = Schema.decodeUnknownEffect(IssueSummary);

/** A linked issue's summary, read from a row the caller already parsed. */
export const decodeParsedGitHubIssueSummary = Effect.fn("decodeParsedGitHubIssueSummary")(
  function* (row: {
    readonly title: string;
    readonly state: string;
    readonly stateReason: string | null;
  }) {
    return yield* decodeNormalizedIssueSummary({
      title: row.title,
      state: state(row.state),
      closeReason: closeReason(row.stateReason),
    });
  },
);

/** A child's close reason keyed by its number, read with one extra GraphQL call because `gh`
 * carries no reason on sub-issue nodes (RSI-Software/t3code-hyprws#1461). */
const RawSubIssueReasons = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        issue: Schema.NullOr(
          Schema.Struct({
            subIssues: Schema.NullOr(
              Schema.Struct({
                nodes: Schema.Array(
                  Schema.Struct({
                    number: Schema.Number,
                    stateReason: Schema.NullOr(Schema.String),
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeSubIssueReasonPayload = Schema.decodeEffect(Schema.fromJsonString(RawSubIssueReasons));

export const decodeGitHubSubIssueReasons = Effect.fn("decodeGitHubSubIssueReasons")(function* (
  raw: string,
) {
  const decoded = yield* decodeSubIssueReasonPayload(raw);
  const reasons = new Map<number, GitHubIssueCloseReasonType | null>();
  for (const node of decoded.data.repository?.issue?.subIssues?.nodes ?? []) {
    reasons.set(node.number, closeReason(node.stateReason));
  }
  return reasons;
});
