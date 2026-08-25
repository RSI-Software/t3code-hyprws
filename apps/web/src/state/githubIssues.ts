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
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { createMergedEnvironmentQuery, type EnvironmentQueryTarget } from "./pullRequests";
import { allEnvironmentShellsBootstrappedAtom, environmentShellBootstrappedAtom } from "./shell";

export const githubIssueEnvironment = createGitHubIssueEnvironmentAtoms(connectionAtomRuntime);

export type GitHubIssueQueryTarget = EnvironmentQueryTarget<GitHubIssueListInput>;

export function githubIssueShellBootstrappedAtom(environmentId: EnvironmentId | null) {
  return environmentId === null
    ? allEnvironmentShellsBootstrappedAtom
    : environmentShellBootstrappedAtom(environmentId);
}

export function useGitHubIssueEnvironmentShellBootstrapped(
  environmentId: EnvironmentId | null,
): boolean {
  return useAtomValue(githubIssueShellBootstrappedAtom(environmentId));
}

const useGitHubIssueListsQuery = createMergedEnvironmentQuery<
  GitHubIssueListInput,
  GitHubIssueListResult
>("web-github-issues:list", githubIssueEnvironment.list);

export function useGitHubIssueList(targets: ReadonlyArray<GitHubIssueQueryTarget>): {
  readonly data: MergedGitHubIssueList | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
} {
  const query = useGitHubIssueListsQuery(targets);
  const data = useMemo(
    () =>
      query.values.length === 0 && query.errors.length === 0
        ? null
        : mergeGitHubIssueLists(query.values, query.errors),
    [query.errors, query.values],
  );
  return { data, isPending: query.isPending, refresh: query.refresh };
}
