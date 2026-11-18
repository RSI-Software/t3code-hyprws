import { findProjectOnChangeRequestHost } from "@t3tools/client-runtime/change-request-links";
import { resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  type EnvironmentId,
  type IssueRef,
  type IssueState,
  type PullRequestPreview,
  type PullRequestRef,
} from "@t3tools/contracts";

import { issueEnvironment } from "~/state/issues";
import { issueTrackerEnvironment } from "~/state/issueTrackers";
import { pullRequestEnvironment } from "~/state/pullRequests";
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

/** The read's title and state; `enabled` false reads nothing and returns null. */
export function useReferenceSummaryFork(
  read: ReferenceReadFork | null,
  enabled: boolean,
): ReferenceSummaryFork | null {
  const issueRead = read?.kind === "issue" ? read : null;
  const issue = useEnvironmentQuery(
    enabled && issueRead !== null ? issueEnvironment.detail(issueRead.target) : null,
  );
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
  const detail = issue.data;
  if (detail !== null && issueRead !== null) {
    if (
      issueRead.workspace !== null &&
      linearIssueLinkTarget(detail.url)?.repository.split("/")[0] !== issueRead.workspace
    ) {
      return null;
    }
    return {
      kind: "issue",
      scope: detail.scope,
      displayKey: detail.displayKey,
      title: detail.title,
      url: detail.url,
      state: { kind: "issue", state: detail.state },
      author: actor(detail.author),
      createdAt: detail.createdAt,
    };
  }
  const preview = pullRequest.data;
  if (preview === null) return null;
  return {
    kind: "pull-request",
    scope: preview.repository,
    displayKey: `#${preview.number}`,
    title: preview.title,
    url: preview.url,
    state: { kind: "pull-request", state: preview.state, isDraft: preview.isDraft ?? false },
    author: actor(preview.author),
    createdAt: preview.createdAt,
  };
}
