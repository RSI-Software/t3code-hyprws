import type { ReferenceAutolink } from "@t3tools/client-runtime/source-control-clients";
import type { PluggableList } from "unified";

import { remarkPullRequestAutolinks } from "../pullRequest/pullRequestMarkdown.logic";

// Fork: agents write GitHub references as `#12`, `repo#12` or `owner/repo#12` instead of URLs.
// The markdown pass marks them with a placeholder href; the anchor renderer resolves it against
// the thread's repository, since the shared parse cache cannot know which thread it serves.

// An https placeholder, so the sanitizer keeps it; no GitHub owner starts with an underscore.
export const GITHUB_REFERENCE_HREF_PREFIX = "https://github.com/_t3-reference/";

const REFERENCE = /(?<![\w./\\#-])(?:([\w.-]+\/[\w.-]+|[A-Za-z][\w.-]*)?#([1-9]\d*))(?!\w)/gu;

export function findGitHubReferences(text: string): ReadonlyArray<ReferenceAutolink> {
  if (!text.includes("#")) return [];
  return Array.from(text.matchAll(REFERENCE), (match) => ({
    index: match.index,
    text: match[0],
    label: match[0],
    url: `${GITHUB_REFERENCE_HREF_PREFIX}${match[1] ?? ""}/${match[2]}`,
    kind: "reference" as const,
  }));
}

export const GITHUB_REFERENCE_REMARK_PLUGINS_FORK: PluggableList = [
  [remarkPullRequestAutolinks, { autolinks: findGitHubReferences }],
];

/**
 * The GitHub URL a placeholder names: a bare `#12` is the thread repository's, `repo#12` a
 * sibling under the same owner. Null when the thread has no GitHub repository to resolve against.
 */
export function resolveGitHubReferenceHref(
  href: string,
  repository: { readonly owner: string; readonly name: string } | null,
): string | null {
  const parts = href.slice(GITHUB_REFERENCE_HREF_PREFIX.length).split("/");
  const number = parts.pop();
  const qualifier = parts.filter(Boolean);
  if (qualifier.length === 2) return `https://github.com/${qualifier.join("/")}/issues/${number}`;
  if (repository === null) return null;
  const name = qualifier[0] ?? repository.name;
  return `https://github.com/${repository.owner}/${name}/issues/${number}`;
}
