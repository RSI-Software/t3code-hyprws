import { WS_METHODS } from "@t3tools/contracts";
import type {
  EnvironmentId,
  GitHubIssueListEntry,
  GitHubIssueListProjectError,
  GitHubIssueListResult,
  GitHubIssueRef,
} from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export type EnvironmentGitHubIssueRef = GitHubIssueRef & {
  readonly environmentId: EnvironmentId;
};

export type EnvironmentGitHubIssueListEntry = GitHubIssueListEntry & {
  readonly environmentId: EnvironmentId;
};

export type EnvironmentGitHubIssueListProjectError = GitHubIssueListProjectError & {
  readonly environmentId: EnvironmentId;
};

export interface GitHubIssueEnvironmentError {
  readonly environmentId: EnvironmentId;
  readonly message: string;
}

export interface MergedGitHubIssueList {
  readonly entries: ReadonlyArray<EnvironmentGitHubIssueListEntry>;
  readonly errors: ReadonlyArray<EnvironmentGitHubIssueListProjectError>;
  readonly environmentErrors: ReadonlyArray<GitHubIssueEnvironmentError>;
  readonly truncated: boolean;
}

export function environmentGitHubIssueKey(reference: EnvironmentGitHubIssueRef): string {
  return [
    reference.environmentId,
    reference.projectId,
    reference.repository.toLowerCase(),
    reference.number,
  ].join(":");
}

export function mergeGitHubIssueLists(
  values: ReadonlyArray<readonly [EnvironmentId, GitHubIssueListResult]>,
  environmentErrors: ReadonlyArray<GitHubIssueEnvironmentError> = [],
): MergedGitHubIssueList {
  const entries = values
    .flatMap(([environmentId, result]) =>
      result.entries.map((entry) => ({ ...entry, environmentId })),
    )
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const errors = values.flatMap(([environmentId, result]) =>
    result.errors.map((error) => ({ ...error, environmentId })),
  );
  return {
    entries,
    errors,
    environmentErrors,
    truncated: values.some(([, result]) => result.truncated),
  };
}

export function createGitHubIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:github-issues:list",
      tag: WS_METHODS.githubIssuesList,
      staleTimeMs: 30_000,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:github-issues:detail",
      tag: WS_METHODS.githubIssuesDetail,
      staleTimeMs: 15_000,
    }),
  };
}
