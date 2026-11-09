import {
  githubIssueLinkTarget,
  type GitHubSubIssue,
  type ThreadIssueKey,
  type ThreadIssueLink,
} from "@t3tools/contracts";

/** A linked issue and its sub-issues; a child the thread also links carries its own node. */
export interface ThreadIssueTreeNode {
  readonly link: ThreadIssueLink;
  readonly children: ReadonlyArray<{
    readonly child: GitHubSubIssue;
    readonly node: ThreadIssueTreeNode | null;
  }>;
}

const keyOf = (key: ThreadIssueKey) =>
  `${key.host.toLowerCase()}/${key.repository.toLowerCase()}#${key.number}`;

const childKeyOf = (child: GitHubSubIssue) => {
  const target = githubIssueLinkTarget(child.url);
  return target === null ? null : keyOf(target);
};

/**
 * A thread's links as GitHub's hierarchy nests them: a link listed among another link's
 * sub-issues sits under it. A link no rendered parent reaches, as a stale snapshot's cycle
 * would leave, stays at the top so none goes missing.
 */
export function threadIssueTree(
  links: ReadonlyArray<ThreadIssueLink>,
): ReadonlyArray<ThreadIssueTreeNode> {
  const byKey = new Map(links.map((link) => [keyOf(link), link]));
  const nested = new Set<string>();
  for (const link of links) {
    for (const child of link.snapshot?.subIssues ?? []) {
      const key = childKeyOf(child);
      if (key !== null && key !== keyOf(link) && byKey.has(key)) nested.add(key);
    }
  }
  const placed = new Set<string>();
  const build = (link: ThreadIssueLink): ThreadIssueTreeNode => {
    placed.add(keyOf(link));
    return {
      link,
      children: (link.snapshot?.subIssues ?? []).map((child) => {
        const key = childKeyOf(child);
        const linked = key === null ? undefined : byKey.get(key);
        return {
          child,
          node: linked === undefined || placed.has(key!) ? null : build(linked),
        };
      }),
    };
  };
  const roots = links.filter((link) => !nested.has(keyOf(link))).map(build);
  for (const link of links) if (!placed.has(keyOf(link))) roots.push(build(link));
  return roots;
}

/** Closed and total sub-issues, or null for an issue without any. */
export function subIssueProgress(
  link: ThreadIssueLink,
): { readonly closed: number; readonly total: number } | null {
  const children = link.snapshot?.subIssues ?? [];
  if (children.length === 0) return null;
  return {
    closed: children.filter((child) => child.state === "closed").length,
    total: children.length,
  };
}
