import type { GitHubSubIssue, ThreadIssueLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadIssueTree, type ThreadIssueTreeNode } from "./threadIssueTree.logic";

const child = (repository: string, number: number): GitHubSubIssue => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/${repository}/issues/${number}`,
  state: "open",
  closeReason: null,
});

const link = (
  repository: string,
  number: number,
  subIssues: ReadonlyArray<GitHubSubIssue> = [],
): ThreadIssueLink => ({
  host: "github.com",
  repository,
  number,
  url: `https://github.com/${repository}/issues/${number}`,
  source: "manual",
  linkedAt: "2026-11-01T00:00:00.000Z",
  snapshot: {
    title: `Issue ${number}`,
    state: "open",
    subIssues,
    syncedAt: "2026-11-01T00:00:00.000Z",
  },
});

type Shape = [number, Array<number | Shape>];
const shape = (node: ThreadIssueTreeNode): Shape => [
  node.link.number,
  node.children.map(({ child: entry, node: linked }) =>
    linked === null ? entry.number : shape(linked),
  ),
];

describe("threadIssueTree", () => {
  it("nests a linked child under its linked parent, across repositories and letter case", () => {
    const tree = threadIssueTree([
      link("acme/web", 3),
      link("acme/web", 1, [child("Acme/API", 2), child("acme/web", 3), child("acme/web", 4)]),
      link("acme/api", 2),
    ]);
    expect(tree.map(shape)).toEqual([[1, [[2, []], [3, []], 4]]]);
  });

  it("keeps every link of a stale cycle on the page", () => {
    const tree = threadIssueTree([
      link("acme/web", 1, [child("acme/web", 2)]),
      link("acme/web", 2, [child("acme/web", 1)]),
    ]);
    expect(tree.map(shape)).toEqual([[1, [[2, [1]]]]]);
  });
});
