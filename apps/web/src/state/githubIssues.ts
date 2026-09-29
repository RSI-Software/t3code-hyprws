import { useAtomValue } from "@effect/atom-react";
import {
  createGitHubIssueEnvironmentAtoms,
  mergeGitHubIssueLists,
  type MergedGitHubIssueList,
} from "@t3tools/client-runtime/state/github-issues";
import type {
  EnvironmentId,
  GitHubIssueListInput,
  GitHubIssueListResult,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import {
  carryGitHubIssueList,
  gitHubIssueListScope,
} from "../components/githubIssue/githubIssueListCarry.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import type { EnvironmentQueryTarget } from "./pullRequests";
import { createMergedEnvironmentQueryFork } from "./pullRequests.fork";
import { allEnvironmentShellsBootstrappedAtom } from "./shell";
import { environmentShellBootstrappedAtom } from "./windowProjectBootstrap.fork";

export const githubIssueEnvironment = createGitHubIssueEnvironmentAtoms(connectionAtomRuntime);

export type GitHubIssueQueryTarget = EnvironmentQueryTarget<GitHubIssueListInput>;

export function githubIssueShellBootstrappedAtom(environmentId: EnvironmentId | null) {
  return environmentId === null
    ? allEnvironmentShellsBootstrappedAtom
    : environmentShellBootstrappedAtom(environmentId);
}

function useGitHubIssueEnvironmentShellBootstrapped(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(githubIssueShellBootstrappedAtom(environmentId));
}

const useGitHubIssueListsQuery = createMergedEnvironmentQueryFork<
  GitHubIssueListInput,
  GitHubIssueListResult
>("web-github-issues:list", githubIssueEnvironment.list);

/**
 * The merged list for these targets. A new state or search is a new query that starts empty, so
 * while it travels the last answer for the same projects stands in, narrowed to what the new
 * question could show, and `carried` says so.
 */
export function useGitHubIssueList(targets: ReadonlyArray<GitHubIssueQueryTarget>): {
  readonly data: MergedGitHubIssueList | null;
  readonly carried: boolean;
  readonly isPending: boolean;
  readonly refresh: () => void;
} {
  const query = useGitHubIssueListsQuery(targets);
  const answered = useMemo(
    () =>
      query.values.length === 0 && query.errors.length === 0
        ? null
        : mergeGitHubIssueLists(query.values, query.errors),
    [query.errors, query.values],
  );
  const scope = gitHubIssueListScope(targets);
  const [held, setHeld] = useState<{ scope: string; list: MergedGitHubIssueList } | null>(null);
  if (answered !== null && (held?.list !== answered || held.scope !== scope)) {
    setHeld({ scope, list: answered });
  }
  const input = targets[0]?.input;
  const carried = useMemo(
    () =>
      answered === null && query.isPending && input && held?.scope === scope
        ? carryGitHubIssueList(held.list, input)
        : null,
    [answered, held, input, query.isPending, scope],
  );
  return {
    data: answered ?? carried,
    carried: carried !== null,
    isPending: query.isPending,
    refresh: query.refresh,
  };
}
