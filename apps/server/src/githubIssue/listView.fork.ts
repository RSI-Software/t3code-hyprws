import type {
  GitHubIssueListEntry,
  GitHubIssueListInput,
  GitHubIssueListViewFork,
} from "@t3tools/contracts";

export function compareGitHubIssuesFork(
  left: GitHubIssueListEntry,
  right: GitHubIssueListEntry,
  order: GitHubIssueListViewFork["order"] = { sort: "updated", direction: "desc" },
): number {
  const value = (entry: GitHubIssueListEntry) => {
    switch (order.sort) {
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
  };
  const difference = value(left) - value(right);
  const tie =
    order.sort === "updated" && order.direction === "desc" ? 0 : left.number - right.number;
  return (order.direction === "desc" ? -1 : 1) * (difference || tie);
}

/** Qualifiers apply before GitHub selects its search page, including for an empty text query. */
export function gitHubIssueSearchQueryFork(
  repository: string,
  input: GitHubIssueListInput,
): string {
  const filters = (input.listViewFork?.filters ?? []).flatMap((filter) => {
    const values = filter.values.map((value) => JSON.stringify(value));
    if (values.length === 0) return [];
    if (filter.operator === "is-not") {
      return values.map((value) => `-${filter.field}:${value}`);
    }
    // Comma-separated labels are OR; types use the documented boolean grouping.
    return [
      filter.field === "label"
        ? `label:${values.join(",")}`
        : values.length === 1
          ? `type:${values[0]}`
          : `(${values.map((value) => `type:${value}`).join(" OR ")})`,
    ];
  });
  const order = input.listViewFork?.order ?? { sort: "updated", direction: "desc" };
  // GitHub cannot sort the positive/negative sums exposed by the client. Total reactions
  // selects candidates across the repository; the client retains its aggregate ordering.
  const sort = order.sort.startsWith("reactions-") ? "reactions" : order.sort;
  return [
    `repo:${repository}`,
    "is:issue",
    ...(input.state === "all" ? [] : [`state:${input.state}`]),
    ...(input.query === undefined ? [] : [input.query]),
    ...filters,
    `sort:${sort}-${order.direction}`,
  ].join(" ");
}
