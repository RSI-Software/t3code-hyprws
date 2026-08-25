import type { EnvironmentGitHubIssueListEntry } from "@t3tools/client-runtime/state/github-issues";
import type { GitHubIssueLabel, GitHubIssueType } from "@t3tools/contracts";

/**
 * Ordering and narrowing applied to the list the server already returned. The server sorts by
 * update time and caps each project at fifty, so these only reorder and hide what is on screen —
 * a narrowed list can never reach past that cap.
 */

/**
 * GitHub splits ordering in two: which field to sort on, then which end to start from. Borrowing
 * that split keeps the menu four rows long instead of eight, and it means "newest" and "oldest"
 * are one control rather than a pair of near-identical rows.
 *
 * `Best match` is GitHub's own and is deliberately absent: relevance is the search backend's
 * ranking, and this list re-sorts a page it has already been handed.
 */
export const GITHUB_ISSUE_SORTS = [
  { value: "created", label: "Created on" },
  { value: "updated", label: "Last updated" },
  { value: "comments", label: "Total comments" },
  { value: "reactions-positive", label: "Reactions 👍" },
  { value: "reactions-negative", label: "Reactions 👎" },
] as const;

export type GitHubIssueSort = (typeof GITHUB_ISSUE_SORTS)[number]["value"];

/** Descending is GitHub's "Newest"; ascending is its "Oldest". */
export type GitHubIssueDirection = "desc" | "asc";

/**
 * GitHub says "Newest" and "Oldest" whatever the field is, which reads wrong once the field is a
 * count. The two ends keep their meaning and only their names follow the field.
 */
export function gitHubIssueDirectionLabel(
  sort: GitHubIssueSort,
  direction: GitHubIssueDirection,
): string {
  const counted = sort !== "created" && sort !== "updated";
  if (counted) return direction === "desc" ? "Most" : "Fewest";
  return direction === "desc" ? "Newest" : "Oldest";
}

export interface GitHubIssueOrder {
  readonly sort: GitHubIssueSort;
  readonly direction: GitHubIssueDirection;
}

/** The order the merged list already arrives in, so the default re-sorts nothing. */
export const DEFAULT_GITHUB_ISSUE_ORDER: GitHubIssueOrder = { sort: "updated", direction: "desc" };

export function gitHubIssueOrderIsDefault(order: GitHubIssueOrder): boolean {
  return (
    order.sort === DEFAULT_GITHUB_ISSUE_ORDER.sort &&
    order.direction === DEFAULT_GITHUB_ISSUE_ORDER.direction
  );
}

export type GitHubIssueFilterField = "type" | "label";

/** Whether the row keeps what matches its values or drops it. */
export type GitHubIssueFilterOperator = "is" | "is-not";

/**
 * One Linear-style filter row: a field, how it reads, and the names it holds. The names are
 * matched as GitHub sent them, and several are an OR, as GitHub's own label filter is.
 */
export interface GitHubIssueFilter {
  readonly field: GitHubIssueFilterField;
  readonly operator: GitHubIssueFilterOperator;
  readonly values: ReadonlyArray<string>;
}

/** At most one row per field, ANDed together. Empty means every issue. */
export type GitHubIssueListNarrowing = ReadonlyArray<GitHubIssueFilter>;

export const NO_GITHUB_ISSUE_NARROWING: GitHubIssueListNarrowing = [];

export function gitHubIssueNarrowingIsEmpty(narrowing: GitHubIssueListNarrowing): boolean {
  return narrowing.length === 0;
}

export const GITHUB_ISSUE_FILTER_FIELD_LABEL: Record<GitHubIssueFilterField, string> = {
  type: "Type",
  label: "Label",
};

/** How the operator reads beside the values it holds, so a row is a sentence: `Label is any of`. */
export function gitHubIssueFilterOperatorLabel(
  operator: GitHubIssueFilterOperator,
  count: number,
): string {
  if (operator === "is") return count > 1 ? "is any of" : "is";
  return count > 1 ? "is not any of" : "is not";
}

/** Replaces the field's row, adds it when absent, and drops it once it holds no value. */
export function setGitHubIssueFilter(
  narrowing: GitHubIssueListNarrowing,
  next: GitHubIssueFilter,
): GitHubIssueListNarrowing {
  const rest = narrowing.filter((filter) => filter.field !== next.field);
  if (next.values.length === 0) return rest;
  const index = narrowing.findIndex((filter) => filter.field === next.field);
  return index === -1 ? [...rest, next] : narrowing.with(index, next);
}

export function removeGitHubIssueFilter(
  narrowing: GitHubIssueListNarrowing,
  field: GitHubIssueFilterField,
): GitHubIssueListNarrowing {
  return narrowing.filter((filter) => filter.field !== field);
}

/**
 * Adds or removes one name in the field's row, which is the edit a chip in the list and a pick
 * from the add-filter list both make. A missing row starts as `is`.
 */
export function toggleGitHubIssueNarrowing(
  narrowing: GitHubIssueListNarrowing,
  field: GitHubIssueFilterField,
  name: string,
): GitHubIssueListNarrowing {
  const row = narrowing.find((filter) => filter.field === field) ?? {
    field,
    operator: "is",
    values: [],
  };
  const values = row.values.includes(name)
    ? row.values.filter((value) => value !== name)
    : [...row.values, name];
  return setGitHubIssueFilter(narrowing, { ...row, values });
}

/**
 * The types and labels present in this list, which is what the filter menu offers. Drawn from the
 * fetched entries rather than the repository, so the menu can never offer a choice that empties
 * the list. Each keeps its colour, so a menu row and a list row wear the same chip.
 */
export function gitHubIssueFacets(entries: ReadonlyArray<EnvironmentGitHubIssueListEntry>): {
  readonly types: ReadonlyArray<GitHubIssueType>;
  readonly labels: ReadonlyArray<GitHubIssueLabel>;
} {
  const types = new Map<string, GitHubIssueType>();
  const labels = new Map<string, GitHubIssueLabel>();
  for (const entry of entries) {
    if (entry.issueType != null && !types.has(entry.issueType.name)) {
      types.set(entry.issueType.name, entry.issueType);
    }
    for (const label of entry.labels) if (!labels.has(label.name)) labels.set(label.name, label);
  }
  const byName = (left: { name: string }, right: { name: string }) =>
    left.name.localeCompare(right.name);
  return {
    types: [...types.values()].toSorted(byName),
    labels: [...labels.values()].toSorted(byName),
  };
}

function holds(entry: EnvironmentGitHubIssueListEntry, filter: GitHubIssueFilter): boolean {
  if (filter.field === "type") {
    return entry.issueType != null && filter.values.includes(entry.issueType.name);
  }
  return entry.labels.some((label) => filter.values.includes(label.name));
}

function matches(
  entry: EnvironmentGitHubIssueListEntry,
  narrowing: GitHubIssueListNarrowing,
): boolean {
  return narrowing.every((filter) => holds(entry, filter) === (filter.operator === "is"));
}

/**
 * The number a sort reads off one entry. An environment on an older server sends no count at all,
 * and zero is the honest reading of that: it has nothing to say, so it sorts last.
 */
function sortValue(entry: EnvironmentGitHubIssueListEntry, sort: GitHubIssueSort): number {
  switch (sort) {
    case "created":
      return Date.parse(entry.createdAt);
    case "updated":
      return Date.parse(entry.updatedAt);
    case "comments":
      return entry.commentCount ?? 0;
    case "reactions-positive":
      return entry.reactions?.positive ?? 0;
    case "reactions-negative":
      return entry.reactions?.negative ?? 0;
  }
}

export function applyGitHubIssueListView(
  entries: ReadonlyArray<EnvironmentGitHubIssueListEntry>,
  narrowing: GitHubIssueListNarrowing,
  order: GitHubIssueOrder,
): ReadonlyArray<EnvironmentGitHubIssueListEntry> {
  const narrowed = gitHubIssueNarrowingIsEmpty(narrowing)
    ? entries
    : entries.filter((entry) => matches(entry, narrowing));
  if (gitHubIssueOrderIsDefault(order)) return narrowed;
  const sign = order.direction === "desc" ? -1 : 1;
  return narrowed.toSorted((left, right) => {
    const difference = sortValue(left, order.sort) - sortValue(right, order.sort);
    // Ties on a count fall back to issue number, so an ordering never shuffles between renders.
    return sign * (difference === 0 ? left.number - right.number : difference);
  });
}
