import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { MouseEvent } from "react";
import type { useNavigate } from "@tanstack/react-router";
import { findProjectOnChangeRequestHost } from "@t3tools/client-runtime/change-request-links";

import { useRightPanelStore } from "../rightPanelStore";
import { readThreadShell } from "../state/entities";

/**
 * Fork: GitHub links prefer the window's project without a second resolver. Upstream's
 * `findProjectOnChangeRequestHost` stays the only matcher; the active project sorts first in
 * its candidate list, so its own repository still wins and the host-wide fallback meets the
 * preferred project before any other checkout on the host.
 */

function repositoryIdentityOf(project: EnvironmentProject): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  return (
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null)
  );
}

function orderProjectsPreferredFirstFork(
  projects: ReadonlyArray<EnvironmentProject>,
  preferredProjectId?: string,
): ReadonlyArray<EnvironmentProject> {
  if (preferredProjectId === undefined) return projects;
  return projects.toSorted((left, right) => {
    if (left.id === preferredProjectId) return -1;
    if (right.id === preferredProjectId) return 1;
    return 0;
  });
}

/**
 * The project a GitHub link resolves to: exact workspace checkout when one
 * exists, otherwise the preferred (active-window) project on the link's host,
 * otherwise any project checked out from that host.
 */
export function findProjectPreferredFork(
  projects: ReadonlyArray<EnvironmentProject>,
  link: Parameters<typeof findProjectOnChangeRequestHost>[1],
  preferredProjectId?: string,
): EnvironmentProject | undefined {
  return findProjectOnChangeRequestHost(
    orderProjectsPreferredFirstFork(projects, preferredProjectId),
    link,
  );
}

/** The identity's own spelling of the repository when the link refers to it. */
export function linkedRepositoryFork(project: EnvironmentProject, repository: string): string {
  const projectRepository = repositoryIdentityOf(project);
  return projectRepository?.toLowerCase() === repository.toLowerCase()
    ? projectRepository
    : repository;
}

/** Change request links prefer the thread's project and borrow a host checkout outside the panel too. */
export function linkPreferenceFork(resolvedThreadRef: ScopedThreadRef | undefined): {
  readonly projectId?: ProjectId | undefined;
  readonly lendHostProject?: boolean;
} {
  const projectId = resolvedThreadRef ? readThreadShell(resolvedThreadRef)?.projectId : undefined;
  return { projectId, lendHostProject: true };
}

export interface GitHubIssueLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

export function parseGitHubIssueUrl(targetUrl: string): GitHubIssueLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  // GitHub Enterprise hosts are arbitrary. The workspace project match in the click handler is
  // the safety gate that keeps an ordinary link from being claimed by the issue surface.
  const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  return claim(host, match);
}

function claim(host: string, match: RegExpExecArray | null): GitHubIssueLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}

/** Everything `useOpenChangeRequestLink` has in scope when a claim is attempted. */
export interface OpenGitHubIssueLinkInput {
  readonly event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  >;
  readonly targetUrl: string;
  readonly resolvedThreadRef: ScopedThreadRef | undefined;
  readonly allProjects: ReadonlyArray<EnvironmentProject>;
  readonly serverConfigs: ReadonlyMap<
    EnvironmentId,
    { environment: { capabilities: { githubIssues?: boolean } } }
  >;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly navigate: ReturnType<typeof useNavigate>;
}

/**
 * Claim a GitHub issue link for the in-app issue surface, or leave it alone. Parsing,
 * candidate ordering through `findProjectPreferredFork`, the right panel open, and the
 * scoped route fallback are fork-owned; the upstream handler carries one marked claim line.
 */
export function openGitHubIssueLinkFork(accept: OpenGitHubIssueLinkInput): boolean {
  const parsedIssue = parseGitHubIssueUrl(accept.targetUrl);
  if (parsedIssue === null) return false;
  const { event, resolvedThreadRef, allProjects, serverConfigs, primaryEnvironmentId, navigate } =
    accept;
  const readsIssues = (environmentId: EnvironmentId) =>
    serverConfigs.get(environmentId)?.environment.capabilities.githubIssues === true;
  const projects = resolvedThreadRef
    ? allProjects.filter((project) => project.environmentId === resolvedThreadRef.environmentId)
    : allProjects
        .filter((project) => readsIssues(project.environmentId))
        .toSorted(
          (left, right) =>
            Number(right.environmentId === primaryEnvironmentId) -
            Number(left.environmentId === primaryEnvironmentId),
        );
  const preferredProjectId = resolvedThreadRef
    ? readThreadShell(resolvedThreadRef)?.projectId
    : undefined;
  const issueProject = findProjectPreferredFork(projects, parsedIssue, preferredProjectId);
  if (issueProject === undefined || !readsIssues(issueProject.environmentId)) return false;
  event.preventDefault();
  event.stopPropagation();
  const repository = linkedRepositoryFork(issueProject, parsedIssue.repository);
  if (resolvedThreadRef) {
    useRightPanelStore.getState().openGitHubIssue(resolvedThreadRef, {
      environmentId: issueProject.environmentId,
      projectId: issueProject.id,
      repository,
      number: parsedIssue.number,
    });
    return true;
  }
  const search = {
    state: "all" as const,
    selectedEnvironmentId: issueProject.environmentId,
    selectedProjectId: issueProject.id,
    repository,
    number: parsedIssue.number,
  };
  void navigate({ to: "/issues", search });
  return true;
}
