import {
  IssueTrackerKind,
  type IssueTrackerProjectBinding,
  type ProjectId,
  type ThreadIssueLink,
} from "@t3tools/contracts";

/** An issue a chat reference names: GitHub's repository, or Linear's `workspace/TEAM`. */
export interface IssueLinkTarget {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

const LINEAR_ISSUE_HOST = "linear.app";

export const isLinearIssueTarget = (target: Pick<IssueLinkTarget, "host">): boolean =>
  target.host.toLowerCase() === LINEAR_ISSUE_HOST;

function parseUrl(url: string): URL | null {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

function githubIssueLinkTarget(url: string): IssueLinkTarget | null {
  const parsed = parseUrl(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return null;
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

export function linearIssueLinkTarget(url: string): IssueLinkTarget | null {
  const parsed = parseUrl(url);
  if (parsed?.protocol !== "https:" || parsed.host.toLowerCase() !== LINEAR_ISSUE_HOST) return null;
  const match = /^\/([\w-]+)\/issue\/([A-Za-z][A-Za-z0-9]*)-(\d+)(?:\/([\w-]+))?\/?$/u.exec(
    parsed.pathname,
  );
  const number = Number(match?.[3]);
  if (!match?.[1] || !match[2] || !Number.isSafeInteger(number) || number < 1) return null;
  const workspace = match[1].toLowerCase();
  const team = match[2].toUpperCase();
  const slug = match[4] ? `/${match[4].toLowerCase()}` : "";
  return {
    host: LINEAR_ISSUE_HOST,
    repository: `${workspace}/${team}`,
    number,
    url: `https://${LINEAR_ISSUE_HOST}/${workspace}/issue/${team}-${number}${slug}`,
  };
}

/** `ENG-123` for a Linear target. */
export const linearIssueIdentifier = (target: IssueLinkTarget): string =>
  `${target.repository.split("/")[1]?.toUpperCase() ?? ""}-${target.number}`;

/** A Linear URL's title slug as words, or null. Linear cuts long slugs short. */
export function linearIssueSlugTitle(url: string): string | null {
  const slug = /\/issue\/[^/]+\/([\w-]+)\/?$/u.exec(url)?.[1];
  if (!slug) return null;
  const words = slug.replaceAll("-", " ").trim();
  return words.length === 0 ? null : words[0]!.toUpperCase() + words.slice(1);
}

/** The thread's issue links as chat reference targets; a link whose URL names neither is skipped. */
export const threadIssueLinkTargets = (
  issues: ReadonlyArray<ThreadIssueLink>,
): ReadonlyArray<IssueLinkTarget> =>
  issues.flatMap(
    (link) => linearIssueLinkTarget(link.url) ?? githubIssueLinkTarget(link.url) ?? [],
  );

export const LINEAR_TRACKER = IssueTrackerKind.make("linear");

/** The project a Linear team reads through: its own binding first, else any Linear binding. */
export function linearLenderFork(
  bindings: Readonly<Record<string, IssueTrackerProjectBinding>>,
  team: string,
  preferredProjectId: string | null,
): ProjectId | null {
  const linear = Object.entries(bindings).filter(
    ([, binding]) => binding.tracker === LINEAR_TRACKER,
  );
  const prefer = (candidates: typeof linear) =>
    (candidates.find(([projectId]) => projectId === preferredProjectId) ?? candidates[0])?.[0];
  const own = prefer(linear.filter(([, binding]) => binding.scope.toUpperCase() === team));
  return ((own ?? prefer(linear)) as ProjectId | undefined) ?? null;
}
