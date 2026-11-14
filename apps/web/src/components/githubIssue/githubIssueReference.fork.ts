import { RegistryContext } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { githubIssueEnvironment } from "../../state/githubIssues";

interface IssueReferenceTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
}

/** The chat chips' long-cached state read for one issue, on its project's own host. */
export function useGitHubIssueReferenceAtom(target: IssueReferenceTarget) {
  const supported =
    useServerConfigs().get(target.environmentId)?.environment.capabilities.githubIssues === true;
  const identity = useProjects().find(
    (project) => project.environmentId === target.environmentId && project.id === target.projectId,
  )?.repositoryIdentity;
  if (!supported || !identity) return null;
  return githubIssueEnvironment.reference({
    environmentId: target.environmentId,
    input: {
      host: sourceControlClients.changeRequestHost(identity, "github"),
      repository: target.repository,
      number: target.number,
    },
  });
}

/** Marks the reference stale without subscribing, so only a mounted reader re-reads it. */
export function useGitHubIssueReferenceInvalidate(target: IssueReferenceTarget) {
  const atom = useGitHubIssueReferenceAtom(target);
  const registry = useContext(RegistryContext);
  return () => {
    if (atom !== null) registry.refresh(atom);
  };
}
