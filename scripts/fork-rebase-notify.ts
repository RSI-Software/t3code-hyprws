#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This standalone GitHub bot runs before an Effect runtime exists.

import * as NodeFS from "node:fs";

import { parseArgs as parseCliArgs, UsageError } from "./lib/fork-cli.ts";
import { runCommand } from "./lib/fork-command.ts";
import {
  closeComment,
  refreshRow,
  type BlockedIssue,
  type RebaseMode,
} from "./lib/fork-rebase-issues.ts";

const BLOCKED_LABEL = "rebase-blocked";
const DOMAIN_LABEL = "ci";
const NOTIFICATION_ISSUE_TYPE = "Notification";
const HIGH_PRIORITY = "High";
const BLOCKING_MARKER = /<!-- blocking-sha:([0-9a-f]{40,64}) -->/;
const REFRESH_LOG_MARKER = "<!-- hyprws-rebase-refresh-log -->";
const REFRESH_TAG_MARKER = /<!-- hyprws-rebase-refresh-tag:([^ ]+) -->/;

export interface NotifyInput {
  readonly mode: RebaseMode;
  readonly status: "off" | "no-op" | "advanced";
  readonly oldSha: string;
  readonly newSha: string | null;
  readonly blocked: BlockedIssue | null;
}

export interface RebaseIssue {
  readonly number: number;
  readonly nodeId: string;
  readonly state: "open" | "closed";
  readonly title: string;
  readonly body: string;
  readonly issueType: string | null;
}

export interface RebaseIssueComment {
  readonly id: number;
  readonly body: string;
}

export interface CreateRebaseIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<typeof BLOCKED_LABEL | typeof DOMAIN_LABEL>;
  readonly assignee: "donjor";
  readonly priority: typeof HIGH_PRIORITY;
}

export interface RepositoryIssueType {
  readonly id: string;
  readonly name: string;
  readonly isEnabled: boolean;
}

export interface OrganizationIssueField {
  readonly __typename: string;
  readonly name?: string;
  readonly options?: ReadonlyArray<{ readonly name: string }>;
}

export const findIssueTypeId = (
  types: ReadonlyArray<RepositoryIssueType>,
  name: string,
): string | null =>
  types.find((type) => type.isEnabled && (type.name === name || type.name.startsWith(`${name} `)))
    ?.id ?? null;

export const hasPlainSingleSelectOption = (
  fields: ReadonlyArray<OrganizationIssueField>,
  fieldName: string,
  optionName: string,
): boolean =>
  fields.some(
    (field) =>
      field.__typename === "IssueFieldSingleSelect" &&
      field.name === fieldName &&
      field.options?.some((option) => option.name === optionName) === true,
  );

export interface RebaseGitHubClient {
  ensureBlockedLabel(): void;
  listBlockedIssues(): ReadonlyArray<RebaseIssue>;
  listIssueComments(issueNumber: number): ReadonlyArray<RebaseIssueComment>;
  lookupIssueTypeId(issueType: typeof NOTIFICATION_ISSUE_TYPE): string;
  applyIssueType(issue: RebaseIssue, issueTypeId: string): void;
  createIssue(issue: CreateRebaseIssue): RebaseIssue;
  updateIssueBody(issueNumber: number, body: string): void;
  createIssueComment(issueNumber: number, body: string): RebaseIssueComment;
  updateIssueComment(commentId: number, body: string): void;
  closeIssue(issueNumber: number): void;
}

const blockingSha = (issue: RebaseIssue): string | null =>
  BLOCKING_MARKER.exec(issue.body)?.[1] ?? null;

const blockedTag = (blocked: BlockedIssue): string => {
  const tag = blocked.newestUpstreamTagBeyondWindow;
  if (tag === null) throw new Error("blocked issue payload has no tagged rebase horizon");
  return tag;
};

const effectiveTrunkSha = (input: NotifyInput): string | null =>
  input.mode === "on" && input.status === "advanced" ? input.newSha : input.oldSha;

const rowFor = (blocked: BlockedIssue, index: number, at: Date): string =>
  refreshRow({
    index,
    at,
    blockingShortSha: blocked.blockingShortSha,
    tag: blockedTag(blocked),
    upstreamCommitCount: blocked.remainingUpstreamCount,
    conflictingForkCommitCount: blocked.stopCensus?.conflictingForkCommitCount ?? null,
  });

export const initialRefreshLog = (blocked: BlockedIssue, at: Date): string => {
  const tag = blockedTag(blocked);
  return [
    REFRESH_LOG_MARKER,
    "Refresh log  (1 update)",
    "",
    "```text",
    rowFor(blocked, 0, at),
    "",
    `block ${blocked.blockingShortSha} unchanged since #0`,
    "o commit  X block  N nightly tag  S stable tag  Nc = conflicts to that tag",
    "```",
    `<!-- hyprws-rebase-refresh-tag:${tag} -->`,
  ].join("\n");
};

export const appendRefreshLog = (
  current: string,
  blocked: BlockedIssue,
  at: Date,
): string | null => {
  const currentTag = REFRESH_TAG_MARKER.exec(current)?.[1] ?? null;
  const nextTag = blockedTag(blocked);
  if (currentTag === nextTag) return null;
  if (!current.includes(REFRESH_LOG_MARKER)) {
    throw new Error("refresh-log comment is missing its identity marker");
  }
  const rows = current.match(/^#\d+ /gm)?.length ?? 0;
  if (rows === 0 || !/^Refresh log  \(\d+ updates?\)$/m.test(current)) {
    throw new Error("refresh-log comment has an unrecognized shape");
  }
  const blockIndex = current.indexOf("\n\nblock ");
  if (blockIndex === -1) throw new Error("refresh-log comment is missing its block footer");
  return `${current.slice(0, blockIndex)}\n${rowFor(blocked, rows, at)}${current.slice(blockIndex)}`
    .replace(/^Refresh log  \(\d+ updates?\)$/m, `Refresh log  (${rows + 1} updates)`)
    .replace(REFRESH_TAG_MARKER, `<!-- hyprws-rebase-refresh-tag:${nextTag} -->`);
};

const refreshIssue = (
  client: RebaseGitHubClient,
  issueNumber: number,
  blocked: BlockedIssue,
  at: Date,
): void => {
  const comments = client
    .listIssueComments(issueNumber)
    .filter((comment) => comment.body.includes(REFRESH_LOG_MARKER));
  if (comments.length > 1) {
    throw new Error(`issue #${issueNumber} has more than one Refresh log comment`);
  }
  const comment = comments[0];
  if (comment === undefined) {
    client.createIssueComment(issueNumber, initialRefreshLog(blocked, at));
    return;
  }
  const updated = appendRefreshLog(comment.body, blocked, at);
  if (updated !== null) client.updateIssueComment(comment.id, updated);
};

const refreshBlockIssue = (
  client: RebaseGitHubClient,
  issue: RebaseIssue,
  blocked: BlockedIssue,
  at: Date,
): void => {
  if (
    issue.issueType !== NOTIFICATION_ISSUE_TYPE &&
    issue.issueType?.startsWith(`${NOTIFICATION_ISSUE_TYPE} `) !== true
  ) {
    client.applyIssueType(issue, client.lookupIssueTypeId(NOTIFICATION_ISSUE_TYPE));
  }
  client.updateIssueBody(issue.number, blocked.body);
  refreshIssue(client, issue.number, blocked, at);
};

const closeByIdentity = (client: RebaseGitHubClient, issue: RebaseIssue, comment: string): void => {
  if (blockingSha(issue) === null) {
    throw new Error(`open rebase-blocked issue #${issue.number} has no blocking-sha marker`);
  }
  client.createIssueComment(issue.number, comment);
  client.closeIssue(issue.number);
};

export const reconcileRebaseBlock = (
  client: RebaseGitHubClient,
  input: NotifyInput,
  at = new Date(),
): void => {
  client.ensureBlockedLabel();
  const issues = client.listBlockedIssues();
  const open = issues.filter((issue) => issue.state === "open");
  const desiredSha = input.blocked?.blockingSha ?? null;
  const matchingOpen = open
    .filter((issue) => blockingSha(issue) === desiredSha && desiredSha !== null)
    .toSorted((left, right) => left.number - right.number);
  const kept = matchingOpen[0] ?? null;
  const resolved = closeComment(effectiveTrunkSha(input));

  for (const issue of open) {
    if (kept !== null && issue.number === kept.number) continue;
    const sameShaDuplicate =
      kept !== null && desiredSha !== null && blockingSha(issue) === desiredSha;
    closeByIdentity(
      client,
      issue,
      sameShaDuplicate ? `Superseded by #${kept.number} for the same blocking commit.` : resolved,
    );
  }

  if (input.blocked === null) return;
  if (kept !== null) {
    refreshBlockIssue(client, kept, input.blocked, at);
    return;
  }
  const preCreateMatch = client
    .listBlockedIssues()
    .filter((issue) => issue.state === "open" && blockingSha(issue) === desiredSha)
    .toSorted((left, right) => left.number - right.number)[0];
  if (preCreateMatch !== undefined) {
    refreshBlockIssue(client, preCreateMatch, input.blocked, at);
    return;
  }

  const issueTypeId = client.lookupIssueTypeId(NOTIFICATION_ISSUE_TYPE);
  const created = client.createIssue({
    title: input.blocked.title,
    body: input.blocked.body,
    labels: [BLOCKED_LABEL, DOMAIN_LABEL],
    assignee: "donjor",
    priority: HIGH_PRIORITY,
  });
  client.applyIssueType(created, issueTypeId);
  client.createIssueComment(created.number, initialRefreshLog(input.blocked, at));
};

interface ApiIssue {
  readonly number?: number;
  readonly node_id?: string;
  readonly state?: string;
  readonly title?: string;
  readonly body?: string | null;
  readonly type?: { readonly name?: string } | null;
  readonly pull_request?: unknown;
}

interface ApiComment {
  readonly id?: number;
  readonly body?: string | null;
}

interface IssueTypesQuery {
  readonly repository: {
    readonly issueTypes: { readonly nodes: ReadonlyArray<RepositoryIssueType> };
  } | null;
}

interface PriorityFieldQuery {
  readonly organization: {
    readonly issueFields: { readonly nodes: ReadonlyArray<OrganizationIssueField> };
  } | null;
}

interface IssueMetadata {
  readonly priority: string | null;
}

const requireNumber = (value: number | undefined, field: string): number => {
  if (value === undefined) throw new Error(`GitHub response omitted ${field}`);
  return value;
};

const requireString = (value: string | undefined, field: string): string => {
  if (value === undefined) throw new Error(`GitHub response omitted ${field}`);
  return value;
};

export class SystemGitHub implements RebaseGitHubClient {
  private readonly repository: string;
  private readonly owner: string;
  private readonly name: string;

  constructor(repository: string) {
    const [owner = "", name = "", extra] = repository.split("/");
    if (owner.length === 0 || name.length === 0 || extra !== undefined) {
      throw new Error(`GH_REPO must be an owner/name slug: ${repository}`);
    }
    this.repository = repository;
    this.owner = owner;
    this.name = name;
  }

  private run(args: ReadonlyArray<string>, input?: string): string {
    const result = runCommand("gh", args, {
      ...(input === undefined ? {} : { input }),
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status === 0 && result.error === undefined) return result.stdout;
    const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
    throw new Error(`gh ${args.join(" ")} failed${detail.length === 0 ? "" : `: ${detail}`}`);
  }

  private api<T>(method: "GET" | "POST" | "PATCH", endpoint: string, payload?: unknown): T {
    const args = ["api", "--method", method, endpoint];
    return JSON.parse(
      this.run(payload === undefined ? args : [...args, "--input", "-"], JSON.stringify(payload)),
    ) as T;
  }

  private pages<T>(endpoint: string): ReadonlyArray<T> {
    const pages = JSON.parse(this.run(["api", "--paginate", "--slurp", endpoint])) as ReadonlyArray<
      ReadonlyArray<T>
    >;
    return pages.flat();
  }

  private graphql<T>(query: string, variables: Readonly<Record<string, string>>): T {
    const response = JSON.parse(
      this.run(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables })),
    ) as { readonly data?: T };
    if (response.data === undefined) throw new Error("GitHub GraphQL response omitted data");
    return response.data;
  }

  private issueMetadata(issue: CreateRebaseIssue): IssueMetadata {
    let priority: string | null = null;
    try {
      const result = this.graphql<PriorityFieldQuery>(
        `query($owner: String!) {
          organization(login: $owner) {
            issueFields(first: 100) {
              nodes {
                __typename
                ... on IssueFieldSingleSelect { name options { name } }
              }
            }
          }
        }`,
        { owner: this.owner },
      );
      priority = hasPlainSingleSelectOption(
        result.organization?.issueFields.nodes ?? [],
        "Priority",
        issue.priority,
      )
        ? issue.priority
        : null;
      if (priority === null) {
        process.stderr.write(
          "warning: plain org Priority field is unavailable; Priority remains human-set\n",
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `warning: plain org Priority field is unavailable; Priority remains human-set: ${detail}\n`,
      );
    }
    return { priority };
  }

  private applyIssueMetadata(nodeId: string, metadata: IssueMetadata): void {
    if (metadata.priority === null) return;
    const declarations = ["$id: ID!", "$priority: String!"];
    const fields = [
      "id: $id",
      'issueFieldUpdates: [{ fieldName: "Priority", operation: SET, value: $priority }]',
    ];
    const variables: Record<string, string> = { id: nodeId, priority: metadata.priority };
    this.graphql(
      `mutation(${declarations.join(", ")}) {
        updateIssue(input: { ${fields.join(", ")} }) { issue { id } }
      }`,
      variables,
    );
  }

  ensureBlockedLabel(): void {
    this.run([
      "label",
      "create",
      BLOCKED_LABEL,
      "--color",
      "B60205",
      "--description",
      "The fork stack conflicts with newer upstream history",
      "--force",
      "--repo",
      this.repository,
    ]);
  }

  listBlockedIssues(): ReadonlyArray<RebaseIssue> {
    return this.pages<ApiIssue>(
      `repos/${this.repository}/issues?state=all&labels=${BLOCKED_LABEL}&per_page=100`,
    ).flatMap((issue) => {
      if (issue.pull_request !== undefined) return [];
      if (issue.state !== "open" && issue.state !== "closed") {
        throw new Error("GitHub returned a rebase-blocked issue with an unknown state");
      }
      return [
        {
          number: requireNumber(issue.number, "issue number"),
          nodeId: requireString(issue.node_id, "issue node id"),
          state: issue.state,
          title: issue.title ?? "",
          body: issue.body ?? "",
          issueType: issue.type?.name ?? null,
        },
      ];
    });
  }

  lookupIssueTypeId(issueType: typeof NOTIFICATION_ISSUE_TYPE): string {
    let result: IssueTypesQuery;
    try {
      result = this.graphql<IssueTypesQuery>(
        `query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            issueTypes(first: 50) { nodes { id name isEnabled } }
          }
        }`,
        { owner: this.owner, name: this.name },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`repository issue type ${issueType} lookup failed: ${detail}`);
    }
    const issueTypeId = findIssueTypeId(result.repository?.issueTypes.nodes ?? [], issueType);
    if (issueTypeId === null) {
      throw new Error(`repository issue type ${issueType} was not found or is disabled`);
    }
    return issueTypeId;
  }

  applyIssueType(issue: RebaseIssue, issueTypeId: string): void {
    this.graphql(
      `mutation($id: ID!, $issueTypeId: ID!) {
        updateIssue(input: { id: $id, issueTypeId: $issueTypeId }) { issue { id } }
      }`,
      { id: issue.nodeId, issueTypeId },
    );
  }

  listIssueComments(issueNumber: number): ReadonlyArray<RebaseIssueComment> {
    return this.pages<ApiComment>(
      `repos/${this.repository}/issues/${issueNumber}/comments?per_page=100`,
    ).map((comment) => ({
      id: requireNumber(comment.id, "comment id"),
      body: comment.body ?? "",
    }));
  }

  createIssue(issue: CreateRebaseIssue): RebaseIssue {
    const metadata = this.issueMetadata(issue);
    const created = this.api<ApiIssue>("POST", `repos/${this.repository}/issues`, {
      title: issue.title,
      body: issue.body,
      labels: [...issue.labels],
      assignees: [issue.assignee],
    });
    const nodeId = created.node_id;
    if (nodeId === undefined) throw new Error("GitHub response omitted issue node id");
    this.applyIssueMetadata(nodeId, metadata);
    return {
      number: requireNumber(created.number, "issue number"),
      nodeId,
      state: "open",
      title: created.title ?? issue.title,
      body: created.body ?? issue.body,
      issueType: null,
    };
  }

  updateIssueBody(issueNumber: number, body: string): void {
    this.api("PATCH", `repos/${this.repository}/issues/${issueNumber}`, { body });
  }

  createIssueComment(issueNumber: number, body: string): RebaseIssueComment {
    const created = this.api<ApiComment>(
      "POST",
      `repos/${this.repository}/issues/${issueNumber}/comments`,
      { body },
    );
    return { id: requireNumber(created.id, "comment id"), body: created.body ?? body };
  }

  updateIssueComment(commentId: number, body: string): void {
    this.api("PATCH", `repos/${this.repository}/issues/comments/${commentId}`, { body });
  }

  closeIssue(issueNumber: number): void {
    this.api("PATCH", `repos/${this.repository}/issues/${issueNumber}`, { state: "closed" });
  }
}

export { UsageError } from "./lib/fork-cli.ts";

const HELP = `Usage: node scripts/fork-rebase-notify.ts --input <path>\n`;

export const parseNotifyArgs = (argv: ReadonlyArray<string>): { readonly input: string } => {
  const parsed = parseCliArgs(argv, { values: ["--input"] });
  const input = parsed.values.get("--input");
  if (input === undefined) throw new UsageError("expected --input <path>");
  return { input };
};

export { parseNotifyArgs as parseArgs };

export const run = (argv: ReadonlyArray<string>): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const options = parseNotifyArgs(argv);
    if (!process.env.GH_TOKEN) throw new UsageError("GH_TOKEN is required");
    const repository = process.env.GH_REPO;
    if (!repository) throw new UsageError("GH_REPO is required");
    const input = JSON.parse(NodeFS.readFileSync(options.input, "utf8")) as NotifyInput;
    reconcileRebaseBlock(new SystemGitHub(repository), input);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`failed: ${message}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
