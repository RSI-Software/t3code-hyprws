import type { GitHubChangeRequestOpenMode, GitHubLinkOpenMode } from "@t3tools/contracts/settings";

export type GitHubLinkDestination = "native" | "integrated" | "external";
export type GitHubLinkKind = "repository" | "issue" | "pull-request";

export interface GitHubLinkTarget {
  readonly href: string;
  readonly kind: GitHubLinkKind;
  readonly repository: string;
  readonly number: number | null;
}

export function parseGitHubLinkTarget(href: string | undefined): GitHubLinkTarget | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname !== "github.com") {
    return null;
  }

  const match = /^\/([^/]+\/[^/]+)(?:\/(issues|pull)\/(\d+)(?:\/|$))?/u.exec(url.pathname);
  const repository = match?.[1];
  if (!repository) return null;
  const resource = match[2];
  const number = Number(match[3]);
  if (resource && (!Number.isSafeInteger(number) || number < 1)) return null;

  return {
    href,
    repository,
    kind: resource === "issues" ? "issue" : resource === "pull" ? "pull-request" : "repository",
    number: resource ? number : null,
  };
}

export function githubLinkLabel(target: GitHubLinkTarget): string | null {
  return target.number === null ? null : `${target.repository}#${target.number}`;
}

export function githubLinkDestinations(
  target: GitHubLinkTarget,
  canOpenInPreview: boolean,
): readonly GitHubLinkDestination[] {
  return [
    ...(target.kind === "repository" ? [] : (["native"] as const)),
    ...(canOpenInPreview ? (["integrated"] as const) : []),
    "external",
  ];
}

export function preferredGitHubLinkDestination(options: {
  readonly target: GitHubLinkTarget;
  readonly canOpenInPreview: boolean;
  readonly linkMode: GitHubLinkOpenMode;
  readonly changeRequestMode: GitHubChangeRequestOpenMode;
}): GitHubLinkDestination {
  const preferred =
    options.target.kind === "repository" ? options.linkMode : options.changeRequestMode;
  return githubLinkDestinations(options.target, options.canOpenInPreview).includes(preferred)
    ? preferred
    : "external";
}
