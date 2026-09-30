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

import {
  carryGitHubIssueList,
  gitHubIssueListScope,
} from "../components/githubIssue/githubIssueListCarry.logic";
import {
  gitHubIssueListReadFailed,
  holdGitHubIssueList,
  keepGitHubIssueListRows,
} from "../components/githubIssue/githubIssueListKeep.logic";
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
 * The last answer per scope, kept outside the component so it survives a scope switch and a
 * remount — the rows an all-failing refresh keeps come from here. Scopes are few: one per
 * environment and project the page asks about, so the store needs no eviction.
 */
const heldLists = new Map<string, MergedGitHubIssueList>();

/**
 * The merged list for these targets. A new state or search is a new query that starts empty, so
 * while it travels the last answer for the same projects stands in, narrowed to what the new
 * question could show, and `carried` says so.
 */
export function useGitHubIssueList(targets: ReadonlyArray<GitHubIssueQueryTarget>): {
  readonly data: MergedGitHubIssueList | null;
  readonly carried: boolean;
  /** Rows on screen are not current: an environment's read failed, or every project's read did. */
  readonly stale: boolean;
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
  // A render-phase write: idempotent by answer reference, so it can never loop the render.
  if (answered !== null) holdGitHubIssueList(heldLists, answered, scope);
  const held = heldLists.get(scope) ?? null;
  const input = targets[0]?.input;
  const carried = useMemo(
    () =>
      answered === null && query.isPending && input && held
        ? carryGitHubIssueList(held, input)
        : null,
    [answered, held, input, query.isPending, scope],
  );
  // Rows a read that failed for every project keeps: the last good ones for this scope, stale the
  // way a failed refresh reads, while the current errors still ride the list for the notices.
  const kept =
    answered !== null && gitHubIssueListReadFailed(answered)
      ? keepGitHubIssueListRows(answered, held)
      : null;
  return {
    data: kept ?? answered ?? carried,
    carried: carried !== null,
    stale: query.stale || kept !== null,
    isPending: query.isPending,
    // Wrapped: the fork's refresh takes an override target list, and an onClick that forwards a
    // click event as that argument would throw instead of refetching.
    refresh: () => query.refresh(),
  };
}
