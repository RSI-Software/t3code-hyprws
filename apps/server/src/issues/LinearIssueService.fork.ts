// Fork-owned Linear reads behind `IssueService`: a Linear link's detail, its chat reference, and
// the light summaries the sync reactor folds into link snapshots, and workflow state moves. One
// key, from Settings or `LINEAR_API_KEY`, reads one workspace; with none every read is refused or
// empty.
import {
  type GitHubReferenceSummary,
  type IssueActor,
  type IssueCloseReason,
  type IssueDetail,
  type IssueLabel,
  type IssueSetStateInput,
  type IssueState,
  LinearIssueOperationError,
  type OrchestrationProjectShell,
  type ThreadIssueKey,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import type { GitHubIssueSummary } from "./gitHubIssueJson.ts";

const LINEAR_API_URL = "https://api.linear.app/graphql";
/** Linear caps a page at 250; a link batch never nears it. */
const SUMMARIES_PER_REQUEST = 100;
/** Linear signs upload URLs in markdown for this long, so a client loads images without the key. */
const SIGNED_FILE_URL_SECONDS = 24 * 60 * 60;

/** The server's Linear personal API key, read from its environment. A blank one is none. */
const linearApiKey = Config.Redacted("LINEAR_API_KEY").pipe(
  Config.option,
  Config.map(Option.filter((key) => Redacted.value(key).trim().length > 0)),
  Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
);

/** The `linearIssues` capability: whether this server can read Linear at all. */
export const linearIssuesConfiguredFork = linearApiKey.pipe(Effect.map(Option.isSome));

const RawActor = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});
const RawLabels = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.NullOr(Schema.String) })),
});
const RawState = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  color: Schema.NullOr(Schema.String),
});
const RawSummary = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: RawState,
  labels: RawLabels,
});
const RawPageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});
const RawReference = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  state: RawState,
  updatedAt: Schema.String,
  creator: Schema.NullOr(RawActor),
});
const RawTeamStates = Schema.Struct({
  states: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        type: Schema.String,
        color: Schema.NullOr(Schema.String),
        position: Schema.Number,
      }),
    ),
  }),
});
const RawDetail = Schema.Struct({
  ...RawSummary.fields,
  ...RawReference.fields,
  stateRef: Schema.Struct({ id: Schema.String }),
  team: RawTeamStates,
  identifier: Schema.String,
  description: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  canceledAt: Schema.NullOr(Schema.String),
  assignee: Schema.NullOr(RawActor),
  comments: Schema.Struct({
    pageInfo: RawPageInfo,
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        body: Schema.String,
        createdAt: Schema.String,
        updatedAt: Schema.String,
        url: Schema.String,
        user: Schema.NullOr(RawActor),
      }),
    ),
  }),
});
type RawActor = typeof RawActor.Type;
type RawSummary = typeof RawSummary.Type;
type RawState = typeof RawState.Type;

const Envelope = <S extends Schema.Top>(data: S) =>
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(data)),
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  });
const issueEnvelope = <S extends Schema.Top>(issue: S) =>
  Schema.decodeUnknownEffect(Envelope(Schema.Struct({ issue: Schema.NullOr(issue) })));
const decodeDetailEnvelope = issueEnvelope(RawDetail);
const decodeReferenceEnvelope = issueEnvelope(RawReference);
const decodeOlderCommentsEnvelope = issueEnvelope(
  Schema.Struct({
    url: Schema.String,
    comments: Schema.Struct({
      pageInfo: RawPageInfo,
      nodes: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  }),
);
const decodeTeamStatesEnvelope = issueEnvelope(
  Schema.Struct({ url: Schema.String, team: RawTeamStates }),
);
const decodeUpdateEnvelope = Schema.decodeUnknownEffect(
  Envelope(Schema.Struct({ issueUpdate: Schema.Struct({ success: Schema.Boolean }) })),
);
const decodeSummariesEnvelope = Schema.decodeUnknownEffect(
  Envelope(Schema.Struct({ issues: Schema.Struct({ nodes: Schema.Array(RawSummary) }) })),
);

const SUMMARY_FIELDS =
  "number title url state { name type color } labels(first: 50) { nodes { name color } }";
const ACTOR_FIELDS = "name displayName avatarUrl";
const REFERENCE_FIELDS = `title url state { name type color } updatedAt creator { ${ACTOR_FIELDS} }`;
const TEAM_STATES_FIELDS = "team { states { nodes { id name type color position } } }";
const PAGE_INFO_FIELDS = "pageInfo { hasNextPage endCursor }";
/** The newest comments a detail shows; older ones are only counted. */
const DETAIL_COMMENTS = 100;

const REFERENCE_QUERY = `query LinearIssueReference($id: String!) {
  issue(id: $id) { ${REFERENCE_FIELDS} }
}`;

const DETAIL_QUERY = `query LinearIssueDetail($id: String!) {
  issue(id: $id) {
    ${SUMMARY_FIELDS} ${REFERENCE_FIELDS}
    identifier description createdAt completedAt canceledAt
    stateRef: state { id } ${TEAM_STATES_FIELDS}
    assignee { ${ACTOR_FIELDS} }
    comments(first: ${DETAIL_COMMENTS}) {
      ${PAGE_INFO_FIELDS}
      nodes { id body createdAt updatedAt url user { ${ACTOR_FIELDS} } }
    }
  }
}`;

const TEAM_STATES_QUERY = `query LinearIssueTeamStates($id: String!) {
  issue(id: $id) { url ${TEAM_STATES_FIELDS} }
}`;

const SET_STATE_MUTATION = `mutation LinearIssueSetState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`;

// Linear lists comments newest first and carries no total, so older ones are counted by id.
const OLDER_COMMENTS_QUERY = `query LinearIssueOlderComments($id: String!, $after: String!) {
  issue(id: $id) { url comments(first: 250, after: $after) { ${PAGE_INFO_FIELDS} nodes { id } } }
}`;

// Archived issues stay linked, so a summary read includes them.
const SUMMARIES_QUERY = `query LinearIssueSummaries($team: String!, $numbers: [Float!]) {
  issues(first: ${SUMMARIES_PER_REQUEST}, includeArchived: true, filter: { team: { key: { eq: $team } }, number: { in: $numbers } }) {
    nodes { ${SUMMARY_FIELDS} }
  }
}`;

/** The workspace and team a key names, as Linear spells them in identifiers. */
function keyParts(key: Pick<ThreadIssueKey, "repository">) {
  const [workspace = "", team = ""] = key.repository.split("/");
  return { workspace: workspace.toLowerCase(), team: team.toUpperCase() };
}

/** A key reads one workspace, so an issue in another one is not this link's. */
const inWorkspace = (url: string, workspace: string) =>
  new URL(url).pathname.split("/")[1]?.toLowerCase() === workspace;

/** Done and canceled read as closed, like a GitHub issue closed as completed or not planned. */
function issueState(state: RawState): { state: IssueState; closeReason: IssueCloseReason | null } {
  if (state.type === "completed") return { state: "closed", closeReason: "completed" };
  if (state.type === "canceled" || state.type === "duplicate") {
    return { state: "closed", closeReason: "not planned" };
  }
  return { state: "open", closeReason: null };
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Linear writes a collapsible section as `+++ Title` … `+++`; markdown spells it `<details>`.
 * Markers inside a code fence are code, and an unclosed section stays as written.
 */
function linearMarkdown(markdown: string) {
  const lines = markdown.split("\n");
  let fence: { readonly run: string; readonly indent: number } | null = null;
  let open: { readonly index: number; readonly line: string } | null = null;
  for (const [index, line] of lines.entries()) {
    const [, space = "", run] = /^([ \t]*)(`{3,}|~{3,})/u.exec(line) ?? [];
    const indent = space.replaceAll("\t", "    ").length;
    if (fence !== null) {
      // A closer is a bare run of the fence's character, as long, indented at most 3 columns
      // or, in a list item, no deeper than its opener.
      const closes =
        run?.startsWith(fence.run) === true &&
        indent <= Math.max(3, fence.indent) &&
        line.slice(space.length + run.length).trim() === "";
      if (closes) fence = null;
      continue;
    }
    if (run !== undefined) {
      fence = { run, indent };
      continue;
    }
    const title = /^\+\+\+[ \t]+(\S.*)$/u.exec(line)?.[1];
    if (open === null && title !== undefined) {
      open = { index, line };
      lines[index] = `<details>\n<summary>${escapeHtml(title.trim())}</summary>\n`;
    } else if (open !== null && /^\+\+\+[ \t]*$/u.test(line)) {
      open = null;
      lines[index] = "\n</details>";
    }
  }
  if (open !== null) lines[open.index] = open.line;
  return lines.join("\n");
}

/** A team's workflow states in board order: by category, then Linear's position within it. */
const STATE_ORDER = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
];
const teamStates = (team: typeof RawTeamStates.Type) =>
  team.states.nodes
    .toSorted(
      (left, right) =>
        STATE_ORDER.indexOf(left.type) - STATE_ORDER.indexOf(right.type) ||
        left.position - right.position,
    )
    .map(({ id, name, type, color }) => ({ id, name, type, color }));

const actor = (raw: RawActor | null): IssueActor | null =>
  raw === null
    ? null
    : { login: raw.displayName || raw.name, name: raw.name || null, avatarUrl: raw.avatarUrl };

const labels = (raw: Pick<RawSummary, "labels">): Array<IssueLabel> =>
  raw.labels.nodes.flatMap((label) =>
    label.name.trim().length === 0 ? [] : [{ name: label.name.trim(), color: label.color }],
  );

export class LinearIssueService extends Context.Service<
  LinearIssueService,
  {
    /** Without a key, a detail or reference read fails and summaries are empty. */
    readonly detail: (
      key: ThreadIssueKey,
      project: OrchestrationProjectShell,
    ) => Effect.Effect<IssueDetail, LinearIssueOperationError>;
    readonly reference: (
      key: ThreadIssueKey,
    ) => Effect.Effect<GitHubReferenceSummary | null, LinearIssueOperationError>;
    /** Moves the issue to a workflow state: the one named, else the first of the folded kind. */
    readonly setState: (
      input: IssueSetStateInput,
    ) => Effect.Effect<void, LinearIssueOperationError>;
    /** Light reads of one team's issues; a number with no issue is left out. */
    readonly summaries: (input: {
      readonly repository: string;
      readonly numbers: ReadonlyArray<number>;
    }) => Effect.Effect<ReadonlyMap<number, GitHubIssueSummary>, LinearIssueOperationError>;
  }
>()("t3/issues/LinearIssueService.fork/LinearIssueService") {}

export const make = Effect.gen(function* () {
  const environmentKey = yield* linearApiKey;
  const client = yield* HttpClient.HttpClient;
  const settings = yield* ServerSettings.ServerSettingsService;

  /**
   * The key saved in Settings, else the environment's, read per request so a new one applies.
   * Settings that cannot be read fail rather than quietly reading as the environment's account.
   */
  const currentKey = Effect.fn("LinearIssueService.currentKey")(
    function* (_operation: string) {
      const saved = (yield* settings.getSettings).linearApiKey;
      return saved === "" ? environmentKey : Option.some(Redacted.make(saved));
    },
    (effect, operation) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new LinearIssueOperationError({
              operation,
              detail: "Could not read the Linear API key saved in Settings.",
              cause,
            }),
        ),
      ),
  );

  const graphql = Effect.fn("LinearIssueService.graphql")(function* (
    operation: string,
    query: string,
    variables: Record<string, unknown>,
  ) {
    const apiKey = yield* currentKey(operation);
    if (Option.isNone(apiKey)) {
      return yield* new LinearIssueOperationError({
        operation,
        detail: "Add a Linear API key in Settings → Source control to read Linear issues.",
      });
    }
    const response = yield* client
      .execute(
        HttpClientRequest.post(LINEAR_API_URL).pipe(
          HttpClientRequest.setHeader("Authorization", Redacted.value(apiKey.value)),
          HttpClientRequest.setHeader(
            "public-file-urls-expire-in",
            String(SIGNED_FILE_URL_SECONDS),
          ),
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
        ),
      )
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new LinearIssueOperationError({
              operation,
              detail: "Linear could not be reached.",
              cause,
            }),
        ),
      );
    if (response.status === 401 || response.status === 403) {
      return yield* new LinearIssueOperationError({
        operation,
        detail: "Linear refused this server's Linear API key.",
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new LinearIssueOperationError({
        operation,
        detail: `Linear answered HTTP ${response.status}.`,
      });
    }
    return yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new LinearIssueOperationError({
            operation,
            detail: "Linear returned unreadable data.",
            cause,
          }),
      ),
    );
  });

  /** One issue by key, or null when it is unknown or in another workspace. */
  const readIssue = Effect.fn("LinearIssueService.readIssue")(function* <
    A extends { readonly url: string },
    E,
  >(
    operation: string,
    query: string,
    decode: (body: unknown) => Effect.Effect<
      {
        readonly data?: { readonly issue: A | null } | null | undefined;
        readonly errors?: ReadonlyArray<{ readonly message: string }> | undefined;
      },
      E
    >,
    key: ThreadIssueKey,
    variables: Record<string, unknown> = {},
  ) {
    const { workspace, team } = keyParts(key);
    const body = yield* graphql(operation, query, { ...variables, id: `${team}-${key.number}` });
    const envelope = yield* decode(body).pipe(
      Effect.mapError(
        (cause) =>
          new LinearIssueOperationError({
            operation,
            detail: "Linear returned unreadable issue data.",
            cause,
          }),
      ),
    );
    const issue = envelope.data?.issue ?? null;
    if (issue !== null && inWorkspace(issue.url, workspace)) return issue;
    // Linear answers an unknown identifier with an error rather than a null issue.
    const errors = envelope.errors ?? [];
    if (issue === null && errors.some((error) => !/not found/iu.test(error.message))) {
      return yield* new LinearIssueOperationError({
        operation,
        detail: "Linear could not read this issue.",
        cause: errors,
      });
    }
    return null;
  });

  /** Comments older than the detail's page, counted by id since Linear keeps no total. */
  const countOlderComments = Effect.fn("LinearIssueService.countOlderComments")(function* (
    key: ThreadIssueKey,
    after: string | null,
  ) {
    let count = 0;
    let cursor = after;
    while (cursor !== null) {
      const page = yield* readIssue(
        "detail",
        OLDER_COMMENTS_QUERY,
        decodeOlderCommentsEnvelope,
        key,
        {
          after: cursor,
        },
      );
      if (page === null) return count;
      count += page.comments.nodes.length;
      cursor = page.comments.pageInfo.hasNextPage ? page.comments.pageInfo.endCursor : null;
    }
    return count;
  });

  const detail: LinearIssueService["Service"]["detail"] = Effect.fn("LinearIssueService.detail")(
    function* (key, project) {
      const issue = yield* readIssue("detail", DETAIL_QUERY, decodeDetailEnvelope, key);
      if (issue === null) {
        return yield* new LinearIssueOperationError({
          operation: "detail",
          detail: `${keyParts(key).team}-${key.number} was not found in this server's Linear workspace.`,
        });
      }
      const page = issue.comments.pageInfo;
      const olderComments = page.hasNextPage ? yield* countOlderComments(key, page.endCursor) : 0;
      const comments = issue.comments.nodes
        .map((comment) => ({
          id: comment.id,
          author: actor(comment.user),
          body: linearMarkdown(comment.body),
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          url: comment.url,
        }))
        .toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
      return {
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
        repository: key.repository,
        number: key.number,
        title: issue.title,
        url: issue.url,
        author: actor(issue.creator),
        assignees: issue.assignee === null ? [] : [actor(issue.assignee)!],
        labels: labels(issue),
        ...issueState(issue.state),
        workflowState: { id: issue.stateRef.id, name: issue.state.name, color: issue.state.color },
        workflowStates: teamStates(issue.team),
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        closedAt: issue.completedAt ?? issue.canceledAt,
        body: linearMarkdown(issue.description ?? ""),
        comments,
        commentCount: comments.length + olderComments,
      } satisfies IssueDetail;
    },
  );

  const setState: LinearIssueService["Service"]["setState"] = Effect.fn(
    "LinearIssueService.setState",
  )(function* (input) {
    const operation = input.state === "closed" ? "close" : "reopen";
    const key = { ...input, host: "linear.app", url: "" };
    // Read first so a move never reaches a same-numbered issue in another workspace.
    const issue = yield* readIssue(operation, TEAM_STATES_QUERY, decodeTeamStatesEnvelope, key);
    if (issue === null) {
      return yield* new LinearIssueOperationError({
        operation,
        detail: `${keyParts(input).team}-${input.number} was not found in this server's Linear workspace.`,
      });
    }
    // Close and reopen name a kind of state, not one; take the team's first of that kind.
    const kind =
      input.state === "open"
        ? "unstarted"
        : input.reason === "not planned"
          ? "canceled"
          : "completed";
    const stateId = teamStates(issue.team).find((state) =>
      input.workflowStateId === undefined
        ? state.type === kind
        : state.id === input.workflowStateId,
    )?.id;
    if (stateId === undefined) {
      return yield* new LinearIssueOperationError({
        operation,
        detail: "This Linear team has no workflow state for that.",
      });
    }
    const { team } = keyParts(input);
    const body = yield* graphql(operation, SET_STATE_MUTATION, {
      id: `${team}-${input.number}`,
      stateId,
    });
    const envelope = yield* decodeUpdateEnvelope(body).pipe(
      Effect.mapError(
        (cause) =>
          new LinearIssueOperationError({
            operation,
            detail: "Linear returned unreadable data.",
            cause,
          }),
      ),
    );
    if (envelope.data?.issueUpdate.success !== true) {
      return yield* new LinearIssueOperationError({
        operation,
        detail: "Linear did not change this issue's state.",
        cause: envelope.errors,
      });
    }
  });

  const reference: LinearIssueService["Service"]["reference"] = Effect.fn(
    "LinearIssueService.reference",
  )(function* (key) {
    const issue = yield* readIssue("reference", REFERENCE_QUERY, decodeReferenceEnvelope, key);
    if (issue === null) return null;
    const { state, closeReason } = issueState(issue.state);
    const creator = actor(issue.creator);
    return {
      kind: "issue",
      title: issue.title,
      url: issue.url,
      state: state === "open" ? "open" : closeReason === "completed" ? "closed" : "not-planned",
      author: creator === null ? null : { login: creator.login, avatarUrl: creator.avatarUrl },
      ownerAvatarUrl: null,
      updatedAt: issue.updatedAt,
    } satisfies GitHubReferenceSummary;
  });

  const summaries: LinearIssueService["Service"]["summaries"] = Effect.fn(
    "LinearIssueService.summaries",
  )(function* (input) {
    const found = new Map<number, GitHubIssueSummary>();
    if (Option.isNone(yield* currentKey("summaries"))) return found;
    const { workspace, team } = keyParts(input);
    const numbers = [...new Set(input.numbers)];
    for (let start = 0; start < numbers.length; start += SUMMARIES_PER_REQUEST) {
      const body = yield* graphql("summaries", SUMMARIES_QUERY, {
        team,
        numbers: numbers.slice(start, start + SUMMARIES_PER_REQUEST),
      });
      const envelope = yield* decodeSummariesEnvelope(body).pipe(
        Effect.mapError(
          (cause) =>
            new LinearIssueOperationError({
              operation: "summaries",
              detail: "Linear returned unreadable issue data.",
              cause,
            }),
        ),
      );
      if (!envelope.data) {
        return yield* new LinearIssueOperationError({
          operation: "summaries",
          detail: "Linear could not read these issues.",
          cause: envelope.errors,
        });
      }
      for (const issue of envelope.data.issues.nodes) {
        if (!inWorkspace(issue.url, workspace)) continue;
        const issueLabels = labels(issue);
        found.set(issue.number, {
          title: issue.title,
          ...issueState(issue.state),
          ...(issueLabels.length === 0 ? {} : { labels: issueLabels }),
        });
      }
    }
    return found;
  });

  return {
    detail,
    reference,
    setState,
    summaries,
  } satisfies LinearIssueService["Service"];
});

export const layer = Layer.effect(LinearIssueService, make);
