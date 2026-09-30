import type { ThreadIssueKey } from "@t3tools/contracts";
import { threadPullRequestKeysEqual } from "@t3tools/shared/threadPullRequests";

/** An issue a thread can link: its host-level key and the address it opens at. */
export interface GitHubIssueLinkTarget extends ThreadIssueKey {
  readonly url: string;
}

/**
 * The link target an issue URL names, or null for anything that is not an issue page. The host
 * keeps a port, so an Enterprise install served on one stays a distinct host, as the agent's
 * link tool keys it.
 */
export function githubIssueLinkTarget(url: string): GitHubIssueLinkTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(parsed.pathname);
  const number = Number(match?.[2]);
  if (!match?.[1] || !Number.isSafeInteger(number) || number < 1) return null;
  const host = parsed.host.toLowerCase();
  return {
    host,
    repository: match[1],
    number,
    url: `${parsed.protocol}//${host}/${match[1]}/issues/${number}`,
  };
}

/** Whether a thread's links hold this issue; host and repository compare case-blind. */
export function threadLinksGitHubIssue(
  links: ReadonlyArray<ThreadIssueKey> | undefined,
  key: ThreadIssueKey,
): boolean {
  return (links ?? []).some((link) => threadPullRequestKeysEqual(link, key));
}

/**
 * Which issue the link dialog's input names, or why it cannot. A URL carries its own host and
 * repository; a bare `#123` can only mean the thread's own GitHub repository.
 */
export function resolveGitHubIssueReference(
  reference: string,
  project: { readonly host: string; readonly repository: string } | null,
): { readonly target: GitHubIssueLinkTarget } | { readonly error: string } | null {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;
  const fromUrl = githubIssueLinkTarget(trimmed);
  if (fromUrl !== null) return { target: fromUrl };
  const bare = /^#?(\d+)$/u.exec(trimmed);
  if (bare === null) return { error: "Paste a GitHub issue URL or an issue number." };
  if (project === null) {
    return { error: "This thread's project is not on GitHub; paste the issue's full URL." };
  }
  const target = githubIssueLinkTarget(
    `https://${project.host}/${project.repository}/issues/${bare[1]}`,
  );
  return target === null ? { error: "Issue numbers start at 1." } : { target };
}
