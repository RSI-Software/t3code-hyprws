import {
  githubIssueLinkTarget,
  issueLinkTarget,
  type IssueLinkTarget,
  type ThreadIssueKey,
} from "@t3tools/contracts";
import { threadPullRequestKeysEqual } from "@t3tools/client-runtime/thread-pull-requests";

/** Whether a thread's links hold this issue; host and repository compare case-blind. */
export function threadLinksIssue(
  links: ReadonlyArray<ThreadIssueKey> | undefined,
  key: ThreadIssueKey,
): boolean {
  return (links ?? []).some((link) => threadPullRequestKeysEqual(link, key));
}

/**
 * Which issue the link dialog's input names, or why it cannot. A URL carries its own host and
 * repository; a bare `#123` can only mean the thread's own GitHub repository. A Linear issue needs
 * its URL, since `ENG-42` alone does not name the workspace.
 */
export function resolveIssueReference(
  reference: string,
  project: { readonly host: string; readonly repository: string } | null,
): { readonly target: IssueLinkTarget } | { readonly error: string } | null {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;
  const fromUrl = issueLinkTarget(trimmed);
  if (fromUrl !== null) return { target: fromUrl };
  const bare = /^#?(\d+)$/u.exec(trimmed);
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/u.test(trimmed)) {
    return { error: "Paste the Linear issue's full URL." };
  }
  if (bare === null) return { error: "Paste a GitHub or Linear issue URL, or an issue number." };
  if (project === null) {
    return { error: "This thread's project is not on GitHub; paste the issue's full URL." };
  }
  const target = githubIssueLinkTarget(
    `https://${project.host}/${project.repository}/issues/${bare[1]}`,
  );
  return target === null ? { error: "Issue numbers start at 1." } : { target };
}
