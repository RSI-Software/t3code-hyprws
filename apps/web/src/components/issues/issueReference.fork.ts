import { RegistryContext } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { LINEAR_ISSUE_HOST, type EnvironmentId } from "@t3tools/contracts";
import { useContext } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { issueEnvironment } from "../../state/issues";

interface IssueReferenceTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  /** `linear.app` for a Linear issue; a GitHub issue reads its project's host. */
  readonly host?: string | undefined;
}

/** The chat chips' long-cached state read for one issue, on its project's own host. */
export function useIssueReferenceAtom(target: IssueReferenceTarget) {
  const capabilities = useServerConfigs().get(target.environmentId)?.environment.capabilities;
  const identity = useProjects().find(
    (project) => project.environmentId === target.environmentId && project.id === target.projectId,
  )?.repositoryIdentity;
  if (target.host === LINEAR_ISSUE_HOST) {
    if (capabilities?.linearIssues !== true) return null;
    return issueEnvironment.reference({
      environmentId: target.environmentId,
      input: { host: LINEAR_ISSUE_HOST, repository: target.repository, number: target.number },
    });
  }
  if (capabilities?.githubIssues !== true || !identity) return null;
  return issueEnvironment.reference({
    environmentId: target.environmentId,
    input: {
      host: sourceControlClients.changeRequestHost(identity, "github"),
      repository: target.repository,
      number: target.number,
    },
  });
}

/** Marks the reference stale without subscribing, so only a mounted reader re-reads it. */
export function useIssueReferenceInvalidate(target: IssueReferenceTarget) {
  const atom = useIssueReferenceAtom(target);
  const registry = useContext(RegistryContext);
  return () => {
    if (atom !== null) registry.refresh(atom);
  };
}
