import type { GitHubIssueListInput } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { gitHubIssueSearchQueryFork } from "./listView.fork.ts";

const input = (
  filters: NonNullable<GitHubIssueListInput["listViewFork"]>["filters"],
  sort: NonNullable<GitHubIssueListInput["listViewFork"]>["order"]["sort"] = "updated",
  direction: "asc" | "desc" = "desc",
): GitHubIssueListInput => ({
  state: "open",
  query: "cache",
  listViewFork: { filters, order: { sort, direction } },
});

describe("Issues search qualifiers", () => {
  it("combines search text with type and OR labels before page selection", () => {
    expect(
      gitHubIssueSearchQueryFork(
        "acme/web",
        input([
          { field: "type", operator: "is", values: ["Bug"] },
          { field: "label", operator: "is", values: ["ui", "help wanted"] },
        ]),
      ),
    ).toBe(
      'repo:acme/web is:issue state:open cache type:"Bug" label:"ui","help wanted" sort:updated-desc',
    );
  });
  it("excludes every selected value rather than ANDing included values", () => {
    expect(
      gitHubIssueSearchQueryFork(
        "acme/web",
        input([
          { field: "type", operator: "is-not", values: ["Bug", "Feature"] },
          { field: "label", operator: "is-not", values: ["ui", "dx"] },
        ]),
      ),
    ).toBe(
      'repo:acme/web is:issue state:open cache -type:"Bug" -type:"Feature" -label:"ui" -label:"dx" sort:updated-desc',
    );
  });
  it("groups multiple types as OR without widening the repository or label scope", () => {
    expect(
      gitHubIssueSearchQueryFork(
        "acme/web",
        input([{ field: "type", operator: "is", values: ["Bug", "Feature"] }]),
      ),
    ).toContain('(type:"Bug" OR type:"Feature")');
  });
  it.each(["created", "updated", "comments", "reactions-positive", "reactions-negative"] as const)(
    "sends both directions of %s to GitHub",
    (sort) => {
      for (const direction of ["asc", "desc"] as const) {
        const query = gitHubIssueSearchQueryFork("acme/web", input([], sort, direction));
        expect(query).toContain(
          `sort:${sort.startsWith("reactions-") ? "reactions" : sort}-${direction}`,
        );
        expect(query.match(/sort:/g)).toHaveLength(1);
      }
    },
  );
  it("keeps the ordinary empty-text search path and all-state scope", () => {
    expect(gitHubIssueSearchQueryFork("acme/web", { state: "all" })).toBe(
      "repo:acme/web is:issue sort:updated-desc",
    );
  });
});
