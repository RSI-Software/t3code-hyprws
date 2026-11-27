// Fork-only (colleague-collab): the project "Fork to my machine" preselects for a colleague's thread.
import {
  type ProjectId,
  repositoryGroupingKeyOf,
  type RepositoryIdentity,
} from "@t3tools/contracts";

/** The project here whose repository matches the colleague's project's, if exactly one does. */
export const matchingProjectFork = (
  source: { readonly repositoryIdentity?: RepositoryIdentity | null | undefined } | undefined,
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  }>,
): ProjectId | null => {
  const identity = source?.repositoryIdentity;
  if (identity == null) return null;
  const key = repositoryGroupingKeyOf(identity);
  const matches = projects.filter(
    (project) =>
      project.repositoryIdentity != null &&
      repositoryGroupingKeyOf(project.repositoryIdentity) === key,
  );
  return matches.length === 1 ? matches[0]!.id : null;
};
