import {
  createIssueEnvironmentAtoms,
  mergeIssueLists,
  type MergedIssueList,
} from "@t3tools/client-runtime/state/issues";
import type { EnvironmentId, IssueListInput, IssueListResult } from "@t3tools/contracts";

import { carryIssueList, issueListScope } from "../components/issues/issueListCarry.logic";
import {
  issueListReadFailed,
  holdIssueList,
  keepIssueListRows,
} from "../components/issues/issueListKeep.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import type { EnvironmentQueryTarget } from "./pullRequests";
import { createMergedEnvironmentQueryFork } from "./pullRequests.fork";
import { allEnvironmentShellsBootstrappedAtom } from "./shell";
import { environmentShellBootstrappedAtom } from "./windowProjectBootstrap.fork";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

export type IssueQueryTarget = EnvironmentQueryTarget<IssueListInput>;

export function issueShellBootstrappedAtom(environmentId: EnvironmentId | null) {
  return environmentId === null
    ? allEnvironmentShellsBootstrappedAtom
    : environmentShellBootstrappedAtom(environmentId);
}

const useIssueListsQuery = createMergedEnvironmentQueryFork<IssueListInput, IssueListResult>(
  "web-github-issues:list",
  issueEnvironment.list,
);

/**
 * The last answer per scope, kept outside the component so it survives a scope switch and a
 * remount — the rows an all-failing refresh keeps come from here. Scopes are few: one per
 * environment and project the page asks about, so the store needs no eviction.
 */
const heldLists = new Map<string, MergedIssueList>();

/**
 * The merged list for these targets. A new state or search is a new query that starts empty, so
 * while it travels the last answer for the same projects stands in, narrowed to what the new
 * question could show, and `carried` says so.
 */
export function useIssueList(targets: ReadonlyArray<IssueQueryTarget>): {
  readonly data: MergedIssueList | null;
  readonly carried: boolean;
  /** Rows on screen are not current: an environment's read failed, or every project's read did. */
  readonly stale: boolean;
  readonly isPending: boolean;
  readonly refresh: () => void;
} {
  const query = useIssueListsQuery(targets);
  const answered =
    query.values.length === 0 && query.errors.length === 0
      ? null
      : mergeIssueLists(query.values, query.errors);
  const scope = issueListScope(targets);
  // A render-phase write: idempotent by answer reference, so it can never loop the render.
  if (answered !== null) holdIssueList(heldLists, answered, scope);
  const held = heldLists.get(scope) ?? null;
  const input = targets[0]?.input;
  const carried =
    answered === null && query.isPending && input && held ? carryIssueList(held, input) : null;
  // Rows a read that failed for every project keeps: the last good ones for this scope, stale the
  // way a failed refresh reads, while the current errors still ride the list for the notices.
  const kept =
    answered !== null && issueListReadFailed(answered) ? keepIssueListRows(answered, held) : null;
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
