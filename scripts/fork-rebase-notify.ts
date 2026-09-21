#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This standalone GitHub bot runs before an Effect runtime exists.

import * as NodeFS from "node:fs";

import { parseArgs as parseCliArgs, UsageError } from "./lib/fork-cli.ts";
import { runCommand } from "./lib/fork-command.ts";
import { parseUpstreamReleaseTag, type VersionParts } from "./lib/fork-policy.ts";
import {
  closeComment,
  type BlockedIssue,
  type RebaseMode,
  type StableCandidate,
} from "./lib/fork-rebase-issues.ts";

const BLOCKED_LABEL = "rebase-blocked";
const HARD_FAILURE_LABEL = "rebase-hard-failure";
const DOMAIN_LABEL = "ci";
const HARD_FAILURE_MARKER = "<!-- hyprws-rebase-hard-failure -->";
export const UNKNOWN_FAILURE = "unknown failure";
const RELEASE_LABEL = "release";
const NOTIFICATION_ISSUE_TYPE = "Notification";
const HIGH_PRIORITY = "High";
const BLOCKING_MARKER = /<!-- blocking-sha:([0-9a-f]{40,64}) -->/;

export interface NotifyInput {
  readonly mode: RebaseMode;
  readonly status: "off" | "no-op" | "advanced";
  readonly oldSha: string;
  readonly newSha: string | null;
  readonly stableCandidates: ReadonlyArray<StableCandidate>;
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

export interface CreateNotificationIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<
    typeof BLOCKED_LABEL | typeof HARD_FAILURE_LABEL | typeof DOMAIN_LABEL | typeof RELEASE_LABEL
  >;
  readonly assignee?: "donjor";
  readonly priority: typeof HIGH_PRIORITY;
}

export interface HardFailureReport {
  readonly failingStep: string;
  readonly lastErrorLine: string;
  readonly runUrl: string;
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

/** Why an issue closed, in GitHub's own vocabulary. */
export type IssueCloseReason = "completed" | "not_planned";

export interface RebaseGitHubClient {
  ensureBlockedLabel(): void;
  ensureHardFailureLabel(): void;
  listBlockedIssues(): ReadonlyArray<RebaseIssue>;
  listHardFailureIssues(): ReadonlyArray<RebaseIssue>;
  listReleaseIssues(): ReadonlyArray<RebaseIssue>;
  lookupIssueTypeId(issueType: typeof NOTIFICATION_ISSUE_TYPE): string;
  applyIssueType(issue: RebaseIssue, issueTypeId: string): void;
  createIssue(issue: CreateNotificationIssue): RebaseIssue;
  updateIssueBody(issueNumber: number, body: string): void;
  createIssueComment(issueNumber: number, body: string): RebaseIssueComment;
  stableReleaseTagExists(candidate: string): boolean;
  closeIssue(issueNumber: number, reason?: IssueCloseReason): void;
}

const blockingSha = (issue: RebaseIssue): string | null =>
  BLOCKING_MARKER.exec(issue.body)?.[1] ?? null;

const effectiveTrunkSha = (input: NotifyInput): string | null =>
  input.mode === "on" && input.status === "advanced" ? input.newSha : input.oldSha;

const hasNotificationType = (issue: RebaseIssue): boolean =>
  issue.issueType === NOTIFICATION_ISSUE_TYPE ||
  issue.issueType?.startsWith(`${NOTIFICATION_ISSUE_TYPE} `) === true;

const ensureNotificationType = (
  client: RebaseGitHubClient,
  issue: RebaseIssue,
  issueTypeId?: string,
): void => {
  if (hasNotificationType(issue)) return;
  client.applyIssueType(issue, issueTypeId ?? client.lookupIssueTypeId(NOTIFICATION_ISSUE_TYPE));
};

const refreshBlockIssue = (client: RebaseGitHubClient, issue: RebaseIssue, body: string): void => {
  ensureNotificationType(client, issue);
  client.updateIssueBody(issue.number, body);
};

const closeByIdentity = (client: RebaseGitHubClient, issue: RebaseIssue, comment: string): void => {
  if (blockingSha(issue) === null) {
    throw new Error(`open rebase-blocked issue #${issue.number} has no blocking-sha marker`);
  }
  client.createIssueComment(issue.number, comment);
  client.closeIssue(issue.number);
};

export const reconcileRebaseBlock = (client: RebaseGitHubClient, input: NotifyInput): void => {
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
    refreshBlockIssue(client, kept, input.blocked.body);
    return;
  }
  const preCreateMatch = client
    .listBlockedIssues()
    .filter((issue) => issue.state === "open" && blockingSha(issue) === desiredSha)
    .toSorted((left, right) => left.number - right.number)[0];
  if (preCreateMatch !== undefined) {
    refreshBlockIssue(client, preCreateMatch, input.blocked.body);
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
};

export const hardFailureBody = (report: HardFailureReport, at: Date): string =>
  [
    HARD_FAILURE_MARKER,
    `The \`${report.failingStep}\` step of the hyprws auto-rebase workflow exited non-zero.`,
    "",
    `- Failing step: \`${report.failingStep}\``,
    `- Last error line: \`${report.lastErrorLine}\``,
    `- Run: ${report.runUrl}`,
    `- Detected: ${at.toISOString()}`,
  ].join("\n");

/** Keep at most one open hard-failure issue; each recurrence comments with its run. */
export const reconcileHardFailure = (
  client: RebaseGitHubClient,
  report: HardFailureReport,
  at = new Date(),
): void => {
  client.ensureHardFailureLabel();
  const body = hardFailureBody(report, at);
  const existing = client
    .listHardFailureIssues()
    .filter((issue) => issue.state === "open")
    .toSorted((left, right) => left.number - right.number)[0];
  if (existing !== undefined) {
    client.updateIssueBody(existing.number, body);
    client.createIssueComment(existing.number, `Recurred: ${report.runUrl}`);
    return;
  }
  const created = client.createIssue({
    title: "🔔 hyprws auto-rebase crashed (hard failure)",
    body,
    labels: [HARD_FAILURE_LABEL, DOMAIN_LABEL],
    assignee: "donjor",
    priority: HIGH_PRIORITY,
  });
  client.applyIssueType(created, client.lookupIssueTypeId(NOTIFICATION_ISSUE_TYPE));
};

export const closeRecoveredHardFailures = (client: RebaseGitHubClient, at = new Date()): void => {
  for (const issue of client.listHardFailureIssues()) {
    if (issue.state !== "open") continue;
    client.createIssueComment(
      issue.number,
      `Recovered: the auto-rebase completed cleanly at ${at.toISOString()}.`,
    );
    client.closeIssue(issue.number, "completed");
  }
};

const matchesStableCandidate = (issue: RebaseIssue, candidate: StableCandidate): boolean =>
  issue.body.includes(candidate.marker);

const STABLE_CANDIDATE_MARKER = /<!-- hyprws-stable-candidate: (v\d+\.\d+\.\d+)-hyprws -->/;

interface OpenStableCandidate {
  readonly issue: RebaseIssue;
  /** The `vX.Y.Z-hyprws` release this candidate would be cut as. */
  readonly name: string;
  readonly version: VersionParts;
}

/** Newest release first, then oldest issue first so a duplicate pair keeps the original. */
const byNewestCandidate = (left: OpenStableCandidate, right: OpenStableCandidate): number =>
  right.version.major - left.version.major ||
  right.version.minor - left.version.minor ||
  right.version.patch - left.version.patch ||
  left.issue.number - right.issue.number;

const openStableCandidate = (issue: RebaseIssue): OpenStableCandidate | null => {
  if (issue.state !== "open") return null;
  const upstream = parseUpstreamReleaseTag(STABLE_CANDIDATE_MARKER.exec(issue.body)?.[1] ?? "");
  return upstream === null ? null : { issue, name: `${upstream.tag}-hyprws`, version: upstream };
};

/**
 * Leave exactly one open candidate: the newest release nobody has cut yet.
 *
 * `stable-list` offers every open candidate as a choice, so a candidate that has been
 * cut or overtaken is a wrong choice sitting in the list, and the notification route
 * only works if the issue a fresh session lands on is the live one
 * (RSI-Software/t3code-hyprws#500).
 */
const closeSettledStableCandidates = (
  client: RebaseGitHubClient,
  issues: ReadonlyArray<RebaseIssue>,
): void => {
  const uncut: Array<OpenStableCandidate> = [];
  for (const issue of issues) {
    const candidate = openStableCandidate(issue);
    if (candidate === null) continue;
    if (!client.stableReleaseTagExists(candidate.name)) {
      uncut.push(candidate);
      continue;
    }
    client.createIssueComment(
      candidate.issue.number,
      `Cut: \`origin\` carries a \`${candidate.name}\` release tag.`,
    );
    client.closeIssue(candidate.issue.number, "completed");
  }
  const [newest, ...superseded] = uncut.toSorted(byNewestCandidate);
  if (newest === undefined) return;
  for (const candidate of superseded) {
    client.createIssueComment(
      candidate.issue.number,
      `Superseded by #${newest.issue.number}, the candidate for \`${newest.name}\`.`,
    );
    client.closeIssue(candidate.issue.number, "not_planned");
  }
};

/**
 * Open a candidate issue for each stable snapshot this run published, then settle the
 * open ones. Closing is work every run owes, so an empty candidate set is not a reason
 * to skip it.
 */
export const reconcileStableCandidates = (
  client: RebaseGitHubClient,
  candidates: ReadonlyArray<StableCandidate>,
): void => {
  let issues = client.listReleaseIssues();
  let issueTypeId: string | null = null;
  const notificationTypeId = (): string => {
    issueTypeId ??= client.lookupIssueTypeId(NOTIFICATION_ISSUE_TYPE);
    return issueTypeId;
  };

  for (const candidate of candidates) {
    let matching = issues.filter((issue) => matchesStableCandidate(issue, candidate));
    if (matching.length === 0) {
      issues = client.listReleaseIssues();
      matching = issues.filter((issue) => matchesStableCandidate(issue, candidate));
    }
    if (matching.length > 0) {
      for (const issue of matching) {
        if (!hasNotificationType(issue)) {
          ensureNotificationType(client, issue, notificationTypeId());
        }
      }
      continue;
    }

    const typeId = notificationTypeId();
    const created = client.createIssue({
      title: candidate.title,
      body: candidate.body,
      labels: [RELEASE_LABEL],
      priority: HIGH_PRIORITY,
    });
    client.applyIssueType(created, typeId);
    issues = [...issues, created];
  }

  closeSettledStableCandidates(client, issues);
};

const captureFailure = (failures: Array<unknown>, action: () => void): void => {
  try {
    action();
  } catch (error) {
    failures.push(error);
  }
};

export const reconcileForkIssues = (
  client: RebaseGitHubClient,
  input: NotifyInput,
  at = new Date(),
): void => {
  const failures: Array<unknown> = [];
  captureFailure(failures, () => reconcileRebaseBlock(client, input));
  captureFailure(failures, () => reconcileStableCandidates(client, input.stableCandidates));
  captureFailure(failures, () => closeRecoveredHardFailures(client, at));
  if (failures.length > 0) {
    throw new Error(
      failures.map((error) => (error instanceof Error ? error.message : String(error))).join("; "),
      { cause: failures[0] },
    );
  }
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

  private issueMetadata(issue: CreateNotificationIssue): IssueMetadata {
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

  private listIssuesByLabel(label: string): ReadonlyArray<RebaseIssue> {
    return this.pages<ApiIssue>(
      `repos/${this.repository}/issues?state=all&labels=${label}&per_page=100`,
    ).flatMap((issue) => {
      if (issue.pull_request !== undefined) return [];
      if (issue.state !== "open" && issue.state !== "closed") {
        throw new Error("GitHub returned a labelled issue with an unknown state");
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

  listBlockedIssues(): ReadonlyArray<RebaseIssue> {
    return this.listIssuesByLabel(BLOCKED_LABEL);
  }

  ensureHardFailureLabel(): void {
    this.run([
      "label",
      "create",
      HARD_FAILURE_LABEL,
      "--color",
      "B60205",
      "--description",
      "The hyprws auto-rebase workflow crashed before it could report",
      "--force",
      "--repo",
      this.repository,
    ]);
  }

  listHardFailureIssues(): ReadonlyArray<RebaseIssue> {
    return this.listIssuesByLabel(HARD_FAILURE_LABEL);
  }

  listReleaseIssues(): ReadonlyArray<RebaseIssue> {
    return this.listIssuesByLabel(RELEASE_LABEL);
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
      throw new Error(`repository issue type ${issueType} lookup failed: ${detail}`, {
        cause: error,
      });
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

  createIssue(issue: CreateNotificationIssue): RebaseIssue {
    const metadata = this.issueMetadata(issue);
    const created = this.api<ApiIssue>("POST", `repos/${this.repository}/issues`, {
      title: issue.title,
      body: issue.body,
      labels: [...issue.labels],
      ...(issue.assignee === undefined ? {} : { assignees: [issue.assignee] }),
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

  stableReleaseTagExists(candidate: string): boolean {
    // A cut release is `<candidate>.N`, so the trailing dot keeps a prefix match from
    // reporting an unrelated tag that merely starts with this candidate's name.
    return (
      this.api<ReadonlyArray<unknown>>(
        "GET",
        `repos/${this.repository}/git/matching-refs/tags/${candidate}.`,
      ).length > 0
    );
  }

  closeIssue(issueNumber: number, reason?: IssueCloseReason): void {
    this.api("PATCH", `repos/${this.repository}/issues/${issueNumber}`, {
      state: "closed",
      ...(reason === undefined ? {} : { state_reason: reason }),
    });
  }
}

export { UsageError } from "./lib/fork-cli.ts";

const HELP = `Usage: node scripts/fork-rebase-notify.ts --input <path>
       node scripts/fork-rebase-notify.ts --hard-failure --failing-step <name> --error-log <path> --run-url <url>
`;

const requireValue = (values: ReadonlyMap<string, string>, name: string): string => {
  const value = values.get(name);
  if (value === undefined) throw new UsageError(`expected ${name} <value>`);
  return value;
};

export interface HardFailureCliOptions {
  readonly failingStep: string;
  readonly errorLog: string;
  readonly runUrl: string;
}

export type NotifyCliOptions =
  | { readonly mode: "issues"; readonly input: string }
  | ({ readonly mode: "hard-failure" } & HardFailureCliOptions);

export const parseNotifyArgs = (argv: ReadonlyArray<string>): NotifyCliOptions => {
  const parsed = parseCliArgs(argv, {
    values: ["--input", "--failing-step", "--error-log", "--run-url"],
    flags: ["--hard-failure"],
  });
  const input = parsed.values.get("--input");
  if (parsed.flags.has("--hard-failure")) {
    if (input !== undefined)
      throw new UsageError("--hard-failure and --input are mutually exclusive");
    return {
      mode: "hard-failure",
      failingStep: requireValue(parsed.values, "--failing-step"),
      errorLog: requireValue(parsed.values, "--error-log"),
      runUrl: requireValue(parsed.values, "--run-url"),
    };
  }
  for (const name of ["--failing-step", "--error-log", "--run-url"]) {
    if (parsed.values.has(name)) {
      throw new UsageError(`${name} requires --hard-failure`);
    }
  }
  if (input === undefined) throw new UsageError("expected --input <path>");
  return { mode: "issues", input };
};

export { parseNotifyArgs as parseArgs };

// eslint-disable-next-line no-control-regex -- ANSI CSI sequences start with the ESC control byte.
const ANSI_ESCAPE = new RegExp("\\u001B\\[[0-9;]*[A-Za-z]", "g");

/** Last non-blank line of the error log, ANSI-stripped; UNKNOWN_FAILURE when unusable. */
export const lastErrorLineFromFile = (path: string): string => {
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8");
  } catch {
    return UNKNOWN_FAILURE;
  }
  const lines = text
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const failedLine = lines.findLast((line) => line.startsWith("failed: "));
  if (failedLine !== undefined) return failedLine;
  const informativeLine = lines.findLast((line) => /[a-zA-Z]/.test(line));
  if (informativeLine !== undefined) return informativeLine;
  return UNKNOWN_FAILURE;
};

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
    const client = new SystemGitHub(repository);
    if (options.mode === "hard-failure") {
      reconcileHardFailure(client, {
        failingStep: options.failingStep,
        lastErrorLine: lastErrorLineFromFile(options.errorLog),
        runUrl: options.runUrl,
      });
      return 0;
    }
    const input = JSON.parse(NodeFS.readFileSync(options.input, "utf8")) as NotifyInput;
    reconcileForkIssues(client, input);
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
