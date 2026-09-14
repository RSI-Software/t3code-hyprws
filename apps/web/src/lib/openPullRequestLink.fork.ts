import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ChangeRequestLink } from "@t3tools/shared/changeRequestUrl";

import { findProjectOnChangeRequestHost } from "./openPullRequestLink";

/**
 * Fork: the preferred-project policy for GitHub links, without a second
 * project resolver. Upstream's `findProjectOnChangeRequestHost` stays the only
 * matcher; the fork's preference is expressed by ordering the candidate list
 * so the window's active project sorts first before the call — its own
 * repository still wins inside the resolver, and the host-wide fallback now
 * meets the preferred project before any other checkout on the host.
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
  link: ChangeRequestLink,
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
