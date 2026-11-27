import { findProjectOnChangeRequestHost } from "@t3tools/client-runtime/change-request-links";
import { resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type IssueRef,
  type IssueState,
  type IssueSummary,
  type PullRequestPreview,
  type PullRequestRef,
  type PullRequestSummary,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";
import { issueEnvironment } from "~/state/issues";
import { issueTrackerEnvironment } from "~/state/issueTrackers";
import { pullRequestEnvironment, useSharedPullRequestSummary } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useProjects } from "~/state/entities";

import { LINEAR_TRACKER, linearIssueLinkTarget, linearLenderFork } from "./issueLinkTarget.fork";

// Fork: a chat reference's title and state, read through upstream's own issue and pull request
// reads. Any project on the same tracker lends its credentials, so references to other
// repositories and Linear teams read too.

export type ReferenceReadFork =
  | {
      readonly kind: "pull-request";
      readonly target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef };
    }
  | {
      readonly kind: "issue";
      readonly target: { readonly environmentId: EnvironmentId; readonly input: IssueRef };
      /** A GitHub `issues/N` may be a pull request; its read falls back to this. */
      readonly pullRequest: ReferenceReadFork | null;
      /** Linear team keys repeat across workspaces; a read from another one is not this issue. */
      readonly workspace: string | null;
    };

export interface ReferenceSummaryFork {
  readonly kind: "pull-request" | "issue";
  readonly scope: string;
  readonly displayKey: string;
  readonly title: string;
  readonly url: string;
  readonly state:
    | {
        readonly kind: "pull-request";
        readonly state: PullRequestPreview["state"];
        readonly isDraft: boolean;
      }
    | { readonly kind: "issue"; readonly state: IssueState };
  readonly author: {
    readonly login: string;
    readonly name: string | null;
    readonly avatarUrl: string | null;
  } | null;
  readonly createdAt: string | null;
}

function pullRequestRead(
  environmentId: EnvironmentId,
  projects: ReturnType<typeof useProjects>,
  url: string,
): ReferenceReadFork | null {
  const link = sourceControlClients.parseChangeRequestUrl(url)?.link;
  if (link === undefined) return null;
  const project = findProjectOnChangeRequestHost(
    projects.filter((candidate) => candidate.environmentId === environmentId),
    link,
  );
  if (project === undefined) return null;
  return {
    kind: "pull-request",
    target: {
      environmentId,
      input: {
        projectId: project.id,
        host: link.authority ?? link.host,
        repository: link.repository,
        number: link.number,
      },
    },
  };
}

/** How a reference URL reads in this environment, or null when no project can read it. */
export function useReferenceReadFork(
  environmentId: EnvironmentId | null,
  url: string,
  preferredProjectId: string | null,
): ReferenceReadFork | null {
  const projects = useProjects();
  const linear = linearIssueLinkTarget(url);
  const connections = useEnvironmentQuery(
    linear !== null && environmentId !== null
      ? issueTrackerEnvironment.connections({ environmentId, input: {} })
      : null,
  );
  if (environmentId === null) return null;
  if (linear !== null) {
    const [workspace, team] = linear.repository.split("/") as [string, string];
    const projectId = linearLenderFork(connections.data?.bindings ?? {}, team, preferredProjectId);
    if (projectId === null) return null;
    return {
      kind: "issue",
      target: {
        environmentId,
        input: {
          projectId,
          tracker: LINEAR_TRACKER,
          host: "linear.app",
          scope: team,
          key: `${team}-${linear.number}`,
        },
      },
      pullRequest: null,
      workspace,
    };
  }
  if (sourceControlClients.parseChangeRequestUrl(url) !== null) {
    return pullRequestRead(environmentId, projects, url);
  }
  const issue = resolveIssueLinkTarget({
    url,
    projects: projects.filter((project) => project.environmentId === environmentId),
    preferredProjectId: preferredProjectId ?? undefined,
  });
  if (issue === null) return null;
  const asPullRequest = sourceControlClients.changeRequestUrlFromReferenceAutolink(url);
  return {
    kind: "issue",
    target: { environmentId, input: issue.ref },
    pullRequest:
      asPullRequest === null ? null : pullRequestRead(environmentId, projects, asPullRequest),
    workspace: null,
  };
}

const actor = (
  author: { login: string; name?: string | null; avatarUrl?: string | null } | null | undefined,
) =>
  author == null
    ? null
    : { login: author.login, name: author.name ?? null, avatarUrl: author.avatarUrl ?? null };

// The server batches every chip's read into one tracker call and keeps it 3 minutes; a chip that
// remounts as the timeline scrolls reuses this answer instead of asking again.
const issueSummary = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:summary-fork",
  tag: WS_METHODS.issuesSummaryFork,
  staleTimeMs: 180_000,
});

// A mounted chip keeps its query, so its stale time never refetches; reopening its card does.
const REVALIDATE_AFTER_MS = 30_000;

const newer = (a: string | undefined, b: string | undefined) =>
  a !== undefined && (b === undefined || Date.parse(a) > Date.parse(b));

/**
 * The read's title and state; `enabled` false reads nothing. `revalidate` rereads a stale
 * answer, for a card that opens over a chip which has been showing it.
 */
export function useReferenceSummaryFork(
  read: ReferenceReadFork | null,
  enabled: boolean,
): { readonly summary: ReferenceSummaryFork | null; readonly revalidate: () => void } {
  const issueRead = read?.kind === "issue" ? read : null;
  // Linear's hourly quota is shared with every agent, so its chips read a batched summary. Other
  // trackers keep the detail the issue panel refreshes after an edit.
  const linear = issueRead?.target.input.tracker === LINEAR_TRACKER;
  const summaryRead = useEnvironmentQuery(
    enabled && issueRead !== null && linear ? issueSummary(issueRead.target) : null,
  );
  const detailRead = useEnvironmentQuery(
    enabled && issueRead !== null && !linear ? issueEnvironment.detail(issueRead.target) : null,
  );
  const issue = linear ? summaryRead : detailRead;
  const pullRequestTarget =
    read?.kind === "pull-request"
      ? read.target
      : issue.failure !== null && issueRead?.pullRequest?.kind === "pull-request"
        ? issueRead.pullRequest.target
        : null;
  const pullRequest = useEnvironmentQuery(
    enabled && pullRequestTarget !== null
      ? pullRequestEnvironment.preview(pullRequestTarget)
      : null,
  );
  // The pull request panel and lists observe newer state than this chip's own read.
  const shared = useSharedPullRequestSummary(
    enabled ? (pullRequestTarget?.environmentId ?? null) : null,
    enabled ? (pullRequestTarget?.input ?? null) : null,
  );
  // An issue read that failed over to its pull request is expected to fail; it stays settled.
  const queries = pullRequest.data !== null ? [pullRequest] : [issue, pullRequest];
  const revalidate = () => {
    for (const query of queries) {
      if (query.isPending) continue;
      if (query.error !== null || Date.now() - query.dataUpdatedAt > REVALIDATE_AFTER_MS) {
        query.refresh();
      }
    }
  };
  return { summary: summarize(issueRead, issue.data, pullRequest.data, shared), revalidate };
}

function summarize(
  issueRead: Extract<ReferenceReadFork, { kind: "issue" }> | null,
  issue: IssueSummary | null,
  preview: PullRequestPreview | null,
  shared: PullRequestSummary | null,
): ReferenceSummaryFork | null {
  if (issue !== null && issueRead !== null) {
    if (
      issueRead.workspace !== null &&
      linearIssueLinkTarget(issue.url)?.repository.split("/")[0] !== issueRead.workspace
    ) {
      return null;
    }
    return {
      kind: "issue",
      scope: issue.scope,
      displayKey: issue.displayKey,
      title: issue.title,
      url: issue.url,
      state: { kind: "issue", state: issue.state },
      author: actor(issue.author),
      createdAt: issue.createdAt,
    };
  }
  if (preview === null) return null;
  const latest = shared !== null && newer(shared.updatedAt, preview.updatedAt) ? shared : preview;
  return {
    kind: "pull-request",
    scope: preview.repository,
    displayKey: `#${preview.number}`,
    title: latest.title,
    url: preview.url,
    state: { kind: "pull-request", state: latest.state, isDraft: latest.isDraft ?? false },
    author: actor(preview.author),
    createdAt: preview.createdAt,
  };
}
