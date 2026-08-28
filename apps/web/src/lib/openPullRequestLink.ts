import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent } from "react";

import {
  resolveChangeRequestLinkTarget,
  resolvePullRequestPreviewTarget,
} from "@t3tools/client-runtime/change-request-links";
import { pullRequestHostOf } from "@t3tools/contracts"; // fork-hook: github-issues/issue-host-import

import { useOpenLink } from "../browser/useOpenLink";
import { useClientSettings } from "../hooks/useSettings";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, useProjects } from "../state/entities";
import { readThreadShell } from "../state/entities"; // fork-hook: github-issues/open-pull-request-link-thread-shell-import
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";
import { listRouteTarget, resolveProjectRefFromPathname } from "../projectRoutes";

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
} // fork-hook: github-issues/parse-issue-url

function claim(host: string, match: RegExpExecArray | null): GitHubIssueLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
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

export function usePullRequestPreviewTarget(environmentId: EnvironmentId | null, url: string) {
  const projects = useProjects();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return resolvePullRequestPreviewTarget({
    environmentId,
    projects,
    pullRequestsEnabled: serverConfig?.environment.capabilities.pullRequests === true,
    url,
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

function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey"> &
    Partial<Pick<MouseEvent<HTMLElement>, "button">>,
): boolean {
  return event.metaKey || event.ctrlKey || event.button === 1;
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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openInApp = useClientSettings((settings) => settings.pullRequestLinksOpenInApp);
  return (event, targetUrl, targetThreadRef, targetEnvironmentId) => {
    if (!openInApp || shouldOpenPullRequestExternally(event)) return false;
    // Read at click time: every provider status push replaces the config map, and
    // subscribing would hand every rendered link a new handler. Projects likewise, so a
    // link can resolve against a snapshot that arrived after this handler was built.
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
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
    const target = resolveChangeRequestLinkTarget({
      url: targetUrl,
      projects: readProjects(),
      capabilities: (environmentId) => serverConfigs.get(environmentId)?.environment.capabilities,
      environmentId: resolvedThreadRef?.environmentId ?? targetEnvironmentId,
      primaryEnvironmentId,
      lendHostProject: resolvedPanelRef !== undefined,
    });
    if (target === null) return false;
    const { project, repository, number, host } = target;
    event.preventDefault();
    event.stopPropagation();
    const pullRequestsSearch = {
      repository,
      number,
      ...(host === undefined ? {} : { selectedHost: host }),
      selectedProjectId: project.id,
      selectedEnvironmentId: project.environmentId,
    };
    if (resolvedPanelRef) {
      useRightPanelStore.getState().openPullRequest(resolvedPanelRef, {
        // The standalone PR panel has a synthetic ref; each tab keeps its real environment.
        ...(resolvedPanelRef.environmentId === project.environmentId
          ? {}
          : { environmentId: project.environmentId }),
        projectId: project.id,
        ...(host === undefined ? {} : { host }),
        repository,
        url: targetUrl,
        number,
      });
      if (!resolvedThreadRef) {
        void navigate({
          to: "/pull-requests",
          search: (previous) => ({
            ...previous,
            involvement: previous.involvement ?? "all",
            state: previous.state ?? "all",
            ...pullRequestsSearch,
          }),
          replace: true,
        });
      }
      return true;
    }
    void navigate({
      to: "/pull-requests",
      search: { involvement: "all", state: "all", ...pullRequestsSearch },
    });
    return true;
  };
}

export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openChangeRequest = useOpenChangeRequestLink(threadRef);
  const openLink = useOpenLink(threadRef);
  return (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
    if (event.button > 1) return false;
    event.stopPropagation();
    const openInBrowser = shouldOpenPullRequestExternally(event);
    const isAnchor =
      event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
    // Native links handle modified clicks; buttons still need openExternal.
    if (openInBrowser && isAnchor) return false;

    event.preventDefault();
    if (!openInBrowser && openChangeRequest(event, prUrl, targetThreadRef)) return true;

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
  };
}
