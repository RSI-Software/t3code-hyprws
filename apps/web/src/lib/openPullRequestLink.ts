import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useCallback } from "react";

import { pullRequestHostOf, type SourceControlProviderKind } from "@t3tools/contracts";
import { parseChangeRequestUrl, type ChangeRequestLink } from "@t3tools/shared/changeRequestUrl";
import {
  canonicalRepositoryKey,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";

import { useOpenLink } from "../browser/useOpenLink";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { readThreadShell, useProjects, useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { listRouteTarget, resolveProjectRefFromPathname } from "../projectRoutes";

export {
  parseChangeRequestUrl,
  type ChangeRequestLink,
  gitHubPullRequestBrowserUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  matchesLinkedPullRequestUrl,
  changeRequestRepositoryUrl,
} from "@t3tools/shared/changeRequestUrl";

export interface GitHubIssueLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

function repositoryIdentityOf(project: EnvironmentProject): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  return (
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null)
  );
}

export function parseGitHubIssueUrl(targetUrl: string): GitHubIssueLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  // GitHub Enterprise hosts are arbitrary. The workspace project match in the click handler is
  // the safety gate that keeps an ordinary link from being claimed by the issue surface.
  const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  return claim(host, match);
}

function claim(host: string, match: RegExpExecArray | null): GitHubIssueLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}


/**
 * Returns a click handler that opens a pull request URL in the system browser.
 *
 * Stops event propagation/default so activating the link does not also trigger
 * an enclosing row or trigger (e.g. opening the branch dropdown), and surfaces a
 * toast when the local API is unavailable or the open fails.
 */
/**
 * The project a link belongs to, or nothing. Matched the way the server matches: the repository
 * identity is the full path below the host where one was recorded — which is what nested GitLab
 * groups and Azure project paths need — and the host is the first segment of the canonical
 * remote, so github.com and an Enterprise install stay apart.
 */
export function findProjectForChangeRequest(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
): EnvironmentProject | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (!identity) return false;
    const kind = identity.provider as SourceControlProviderKind | undefined;
    if (kind === undefined) return false;
    if (kind === "azure-devops") {
      return (
        canonicalRepositoryKey(identity.canonicalKey.toLowerCase()) ===
        canonicalRepositoryKey(`${link.host}/${link.repository}`.toLowerCase())
      );
    }
    const repository = repositoryIdentityOf(project);
    return (
      repository !== null &&
      repository.toLowerCase() === link.repository.toLowerCase() &&
      pullRequestHostOf(identity, kind) === link.host.toLowerCase()
    );
  });
}

export function findProjectForGitHubIssue(
  projects: ReadonlyArray<EnvironmentProject>,
  link: GitHubIssueLink,
): EnvironmentProject | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (!identity || identity.provider !== "github") return false;
    const repository = repositoryIdentityOf(project);
    const host = pullRequestHostOf(identity, "github");
    return (
      repository !== null &&
      repository.toLowerCase() === link.repository.toLowerCase() &&
      (host === "github" ? "github.com" : host) === link.host.toLowerCase()
    );
  });
}

/**
 * Any project checked out from the link's host. Thread links are host-level, so a pull request
 * from a repository nobody has checked out is still linkable as long as one project on that
 * host can lend the server its credentials. The link's own project, when it exists, comes first.
 */
export function findProjectOnChangeRequestHost(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
): EnvironmentProject | undefined {
  const own = findProjectForChangeRequest(projects, link);
  if (own !== undefined) return own;
  // Azure CLI reads use the checkout's organization and project, not host-wide credentials.
  if (
    canonicalRepositoryKey(`${link.host}/${link.repository}`.toLowerCase()).startsWith(
      "dev.azure.com/",
    )
  )
    return undefined;
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    const kind = identity?.provider as SourceControlProviderKind | undefined;
    return (
      identity != null &&
      kind !== undefined &&
      kind !== "azure-devops" &&
      pullRequestHostOf(identity, kind) === link.host.toLowerCase()
    );
  });
}

/**
 * Uses an exact workspace checkout when one exists, otherwise uses the active GitHub project as
 * the authenticated execution context for another repository on the same host.
 */
export function findProjectForGitHubLink(
  projects: ReadonlyArray<EnvironmentProject>,
  link: GitHubIssueLink,
  preferredProjectId?: string,
): EnvironmentProject | undefined {
  const exact = findProjectForGitHubIssue(projects, link);
  if (exact !== undefined || preferredProjectId === undefined) return exact;
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (project.id !== preferredProjectId || identity?.provider !== "github") return false;
    const host = pullRequestHostOf(identity, "github");
    return (host === "github" ? "github.com" : host) === link.host.toLowerCase();
  });
}

function linkedRepository(project: EnvironmentProject, repository: string): string {
  const projectRepository = repositoryIdentityOf(project);
  return projectRepository?.toLowerCase() === repository.toLowerCase()
    ? projectRepository
    : repository;
}

/**
 * Opens a change request link on the page, and says whether it did. Anything else — another
 * organisation's repository, a host nothing here is checked out from, a link that merely looks
 * like one — is left alone for the caller to handle as the ordinary link it is.
 *
 * Resolving the project here rather than on the page is what makes recognising a URL safe: a
 * lookalike hostname matches no project and stays a link, and the page is handed the project
 * rather than a host to narrow its whole list by.
 *
 * Given a thread, the link opens beside it in the right panel instead of taking the whole app to
 * the pull requests page: a reader following a link the agent wrote is reading the thread, and
 * should still be reading it afterwards. Any change request opens there, not only the thread's
 * own, since the panel is told which one to show.
 */
export function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey">,
): boolean {
  return event.metaKey || event.ctrlKey;
}

export function useOpenChangeRequestLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  >,
  targetUrl: string,
  targetThreadRef?: ScopedThreadRef,
  targetEnvironmentId?: EnvironmentId,
) => boolean {
  const navigate = useNavigate();
  const allProjects = useProjects();
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(
    (event, targetUrl, targetThreadRef, targetEnvironmentId) => {
      if (shouldOpenPullRequestExternally(event)) return false;
      const resolvedThreadRef = targetThreadRef ?? threadRef;
      const resolvedPanelRef = panelRef ?? resolvedThreadRef;
      const parsedIssue = parseGitHubIssueUrl(targetUrl);
      if (parsedIssue !== null) {
        const readsIssues = (environmentId: EnvironmentId) =>
          serverConfigs.get(environmentId)?.environment.capabilities.githubIssues === true;
        const projects = resolvedThreadRef
          ? allProjects.filter(
              (project) => project.environmentId === resolvedThreadRef.environmentId,
            )
          : allProjects
              .filter((project) => readsIssues(project.environmentId))
              .toSorted(
                (left, right) =>
                  Number(right.environmentId === primaryEnvironmentId) -
                  Number(left.environmentId === primaryEnvironmentId),
              );
        const preferredProjectId = resolvedThreadRef
          ? readThreadShell(resolvedThreadRef)?.projectId
          : undefined;
        const issueProject = findProjectForGitHubLink(projects, parsedIssue, preferredProjectId);
        if (issueProject === undefined || !readsIssues(issueProject.environmentId)) return false;
        event.preventDefault();
        event.stopPropagation();
        const repository = linkedRepository(issueProject, parsedIssue.repository);
        if (resolvedThreadRef) {
          useRightPanelStore.getState().openGitHubIssue(resolvedThreadRef, {
            environmentId: issueProject.environmentId,
            projectId: issueProject.id,
            repository,
            number: parsedIssue.number,
          });
          return true;
        }
        const search = {
          state: "all" as const,
          selectedEnvironmentId: issueProject.environmentId,
          selectedProjectId: issueProject.id,
          repository,
          number: parsedIssue.number,
        };
        const windowProjectRef = resolveProjectRefFromPathname(
          typeof window === "undefined" ? "/" : window.location.pathname,
        );
        void navigate({
          ...listRouteTarget("issues", windowProjectRef),
          search: {
            ...search,
            ...(windowProjectRef !== null &&
            (windowProjectRef.environmentId !== issueProject.environmentId ||
              windowProjectRef.projectId !== issueProject.id)
              ? { scope: "all" as const }
              : {}),
          },
        });
        return true;
      }
      const parsed = parseChangeRequestUrl(targetUrl);
      if (parsed === null) return false;
      const reads = (environmentId: string) =>
        serverConfigs.get(environmentId as EnvironmentId)?.environment.capabilities.pullRequests ===
        true;
      // Beside a thread the panel reads on that thread's environment, so a project from another
      // one could not be read there whatever its remote says: two environments can hold the same
      // repository, and handing the panel the wrong one's id opens a surface that never loads.
      //
      // The page has no such tie — it lists every server at once — so the link is resolved
      // against all of them, the primary first where two hold the same repository.
      const projects = resolvedThreadRef
        ? allProjects.filter((project) => project.environmentId === resolvedThreadRef.environmentId)
        : targetEnvironmentId
          ? allProjects.filter((project) => project.environmentId === targetEnvironmentId)
          : allProjects
              .filter((project) => reads(project.environmentId))
              .toSorted(
                (left, right) =>
                  Number(right.environmentId === primaryEnvironmentId) -
                  Number(left.environmentId === primaryEnvironmentId),
              );
      const exactProject = findProjectForChangeRequest(projects, parsed);
      const preferredProjectId = resolvedThreadRef
        ? readThreadShell(resolvedThreadRef)?.projectId
        : undefined;
      const project =
        exactProject ??
        (resolvedPanelRef
          ? findProjectOnChangeRequestHost(
              projects.filter(
                (candidate) =>
                  serverConfigs.get(candidate.environmentId)?.environment.capabilities
                    .threadPullRequests === true,
              ),
              parsed,
            )
          : undefined) ??
        findProjectForGitHubLink(projects, parsed, preferredProjectId);
      if (project === undefined || !reads(project.environmentId)) return false;
      const repository =
        serverConfigs.get(project.environmentId)?.environment.capabilities.threadPullRequests ===
        true
          ? parsed.repository
          : (sourceControlRepositorySelector(project.repositoryIdentity) ?? parsed.repository);
      event.preventDefault();
      event.stopPropagation();
      if (resolvedPanelRef) {
        useRightPanelStore.getState().openPullRequest(resolvedPanelRef, {
          // The standalone PR panel has a synthetic ref; each tab keeps its real environment.
          ...(resolvedPanelRef.environmentId === project.environmentId
            ? {}
            : { environmentId: project.environmentId }),
          projectId: project.id,
          ...(serverConfigs.get(project.environmentId)?.environment.capabilities
            .threadPullRequests === true
            ? { host: parsed.host }
            : {}),
          // The identity's own spelling, not the one read out of the URL: the panel asks the
          // provider for this repository, while matching a link only ever compares lower case.
          repository,
          url: targetUrl,
          number: parsed.number,
        });
        if (!resolvedThreadRef) {
          void navigate({
            to: "/pull-requests",
            search: (previous) => ({
              ...previous,
              involvement: previous.involvement ?? "all",
              state: previous.state ?? "all",
              repository,
              number: parsed.number,
              selectedHost: parsed.host,
              selectedProjectId: project.id,
              selectedEnvironmentId: project.environmentId,
            }),
            replace: true,
          });
        }
        return true;
      }
      const windowProjectRef = resolveProjectRefFromPathname(
        typeof window === "undefined" ? "/" : window.location.pathname,
      );
      void navigate({
        ...listRouteTarget("pull-requests", windowProjectRef),
        search: {
          involvement: "all",
          // Every state, so the pull request being opened is also in the list behind it whether
          // it is open, merged or closed.
          state: "all",
          repository,
          number: parsed.number,
          selectedHost: parsed.host,
          selectedProjectId: project.id,
          // Named so the page opens the right one of two servers holding this project.
          selectedEnvironmentId: project.environmentId,
          ...(windowProjectRef !== null &&
          (windowProjectRef.environmentId !== project.environmentId ||
            windowProjectRef.projectId !== project.id)
            ? { scope: "all" as const }
            : {}),
        },
      });
      return true;
    },
    [allProjects, navigate, panelRef, primaryEnvironmentId, serverConfigs, threadRef],
  );
}

export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openChangeRequest = useOpenChangeRequestLink(threadRef);
  const openLink = useOpenLink(threadRef);
  return useCallback(
    (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
      event.stopPropagation();
      const openInBrowser = shouldOpenPullRequestExternally(event);
      const isAnchor =
        event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
      // A real link already knows how to cmd/ctrl+click. Leave its default
      // action alone so the browser (or Electron's window-open handler) opens
      // the host. Buttons have no href, so they still go through openExternal.
      if (openInBrowser && isAnchor) return false;

      event.preventDefault();
      if (!openInBrowser && openChangeRequest(event, prUrl, targetThreadRef)) return true;

      // No project to show it in, so it is an ordinary link and follows the
      // "Open links in" setting; the modifier still forces the system browser.
      void openLink(prUrl, { event, threadRef: targetThreadRef }).catch((error: unknown) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open pull request link",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
      return false;
    },
    [openChangeRequest, openLink],
  );
}
