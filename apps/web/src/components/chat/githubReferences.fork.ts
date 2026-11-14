import type { ReferenceAutolink } from "@t3tools/client-runtime/source-control-clients";
import { isLinearIssueKey } from "@t3tools/contracts";
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

// A Linear `ENG-42` names no workspace, so it links only to an issue the thread links.
export const LINEAR_REFERENCE_HREF_PREFIX = "https://linear.app/_t3-reference/";

const LINEAR_REFERENCE = /(?<![\w./\\#-])([A-Z][A-Z0-9]{0,9})-([1-9]\d*)(?![\w-])/gu;

export function findLinearReferences(text: string): ReadonlyArray<ReferenceAutolink> {
  if (!text.includes("-")) return [];
  return Array.from(text.matchAll(LINEAR_REFERENCE), (match) => ({
    index: match.index,
    text: match[0],
    label: match[0],
    url: `${LINEAR_REFERENCE_HREF_PREFIX}${match[0]}`,
    kind: "reference" as const,
  }));
}

const findIssueReferences = (text: string): ReadonlyArray<ReferenceAutolink> =>
  [...findGitHubReferences(text), ...findLinearReferences(text)].toSorted(
    (left, right) => left.index - right.index,
  );

export const GITHUB_REFERENCE_REMARK_PLUGINS_FORK: PluggableList = [
  [remarkPullRequestAutolinks, { autolinks: findIssueReferences }],
];

/** A pull request or issue the thread links, which a short reference names before its project. */
export interface LinkedGitHubReference {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

/**
 * The GitHub URL a placeholder names. A bare `#12` or `repo#12` is first the thread's own linked
 * pull request or issue, since agents often work outside the project's repository; failing a
 * single match, `#12` is the thread repository's and `repo#12` a sibling under the same owner.
 * Null when nothing resolves it.
 */
export function resolveGitHubReferenceHref(
  href: string,
  repository: { readonly owner: string; readonly name: string } | null,
  linked: ReadonlyArray<LinkedGitHubReference> = [],
): string | null {
  const parts = href.slice(GITHUB_REFERENCE_HREF_PREFIX.length).split("/");
  const number = parts.pop();
  const qualifier = parts.filter(Boolean);
  if (qualifier.length === 2) return `https://github.com/${qualifier.join("/")}/issues/${number}`;
  const name = qualifier[0]?.toLowerCase();
  const matches = linked.filter(
    (link) =>
      link.host === "github.com" &&
      String(link.number) === number &&
      (name === undefined || link.repository.split("/")[1]?.toLowerCase() === name),
  );
  const [match] = matches;
  if (
    match &&
    matches.every((link) => link.repository.toLowerCase() === match.repository.toLowerCase())
  )
    return match.url;
  if (repository === null) return null;
  return `https://github.com/${repository.owner}/${qualifier[0] ?? repository.name}/issues/${number}`;
}

/** The URL of the one linked Linear issue a placeholder's `ENG-42` names, else null. */
export function resolveLinearReferenceHref(
  href: string,
  linked: ReadonlyArray<LinkedGitHubReference>,
): string | null {
  const [team, number] = href.slice(LINEAR_REFERENCE_HREF_PREFIX.length).split("-");
  const matches = linked.filter(
    (link) =>
      isLinearIssueKey(link) &&
      String(link.number) === number &&
      link.repository.split("/")[1]?.toUpperCase() === team,
  );
  return matches.length === 1 ? matches[0]!.url : null;
}
