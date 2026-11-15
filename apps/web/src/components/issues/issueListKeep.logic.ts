import type { MergedIssueList } from "@t3tools/client-runtime/state/issues";

/**
 * True when a list read no rows at all but carries project errors: every read behind it failed, so
 * it is a failure shape, not an answer — and never a reason to drop the rows already shown.
 */
export function issueListReadFailed(list: MergedIssueList): boolean {
  return list.entries.length === 0 && list.errors.length > 0;
}

/**
 * Records a landed answer for its scope, keeping the last good one: a read that failed for every
 * project never replaces what the scope holds — its rows must outlive the failure. A scope with
 * nothing held stores even a failed read, so the fold below can tell "failure" from "no read yet".
 * Writes only on change, so a render-phase call is idempotent.
 */
export function holdIssueList(
  store: Map<string, MergedIssueList>,
  answered: MergedIssueList,
  scope: string,
): void {
  if (issueListReadFailed(answered) && store.has(scope)) return;
  if (store.get(scope) !== answered) store.set(scope, answered);
}

/**
 * The list a failed refresh shows: the last good rows under the current errors, so the failure
 * names itself in the notices while the rows stay readable. Null when no rows are held — then the
 * failure is the answer, and the empty state may say so.
 */
export function keepIssueListRows(
  answered: MergedIssueList,
  held: MergedIssueList | null,
): MergedIssueList | null {
  if (held === null || held.entries.length === 0) return null;
  return {
    ...answered,
    entries: held.entries,
    truncated: answered.truncated || held.truncated,
  };
}
