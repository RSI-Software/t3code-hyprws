import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { readLocalApi } from "~/localApi";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings } from "~/hooks/useSettings";
import { useProject, useThreadShell } from "~/state/entities";
import { useRightPanelStore } from "~/rightPanelStore";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { showExternalLinkContextMenu } from "./externalLinkContextMenu";
import { GitHubReferenceLink } from "./GitHubReferenceLink.fork";
import { GITHUB_REFERENCE_HREF_PREFIX, resolveGitHubReferenceHref } from "./githubReferences.fork";

// Fork: GitHub link destination controls (target parsing, destination policy
// from the open-mode client settings, open dispatch, context menu), so
// `ChatMarkdown.tsx` carries only marked hook lines.

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

type GitHubLinkOpenMode = "integrated" | "external";
type GitHubChangeRequestOpenMode = "native" | "integrated" | "external";

/** What the anchor renderer hands the destination controller when it takes a link over. */
export interface GitHubDestinationRenderInput {
  readonly href: string;
  readonly props: ComponentPropsWithoutRef<"a">;
  readonly children: ReactNode;
  /** The link's label when it is plain text; null for images or formatted labels. */
  readonly written: string | null;
  readonly canOpenInPreview: boolean;
  /** Operate scope on the link's thread environment; gates the link-to-thread write. */
  readonly canOperateHost: boolean;
  readonly faviconHost: string | null;
  readonly openChangeRequestLink: (
    event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
    targetUrl: string,
  ) => boolean;
  readonly linkedThreadPullRequestFor: (href: string) => unknown;
  readonly resolveThreadPullRequest: (href: string) => unknown;
  readonly updateThreadPullRequestLink: (href: string, linked: boolean) => Promise<void>;
}

interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
}

type AtomLikeResult = { readonly _tag: string; readonly cause: unknown };

function isAtomInterrupted(result: unknown): boolean {
  return isAtomCommandInterrupted(result as Parameters<typeof isAtomCommandInterrupted>[0]);
}

/**
 * The destination controller for one chat markdown surface. Reads the two
 * open-mode settings so the anchor renderer can stay upstream-shaped.
 */
export function useGitHubDestinationLinkFork(accept: {
  /** The surface's preview-open callback, already wired to its reporting. */
  readonly openExternalLinkInPreview: (href: string) => Promise<unknown>;
  readonly environmentId: EnvironmentId | null;
  readonly threadRef: ScopedThreadRef | undefined;
}): {
  /** A written `repo#12` placeholder as its GitHub URL; null when it resolves to nothing. */
  resolveHref: (href: string | undefined) => string | null | undefined;
  claims: (href: string | undefined) => boolean;
  render: (input: GitHubDestinationRenderInput) => ReactNode;
} {
  const linkMode = useClientSettings((settings) => settings.githubLinkOpenMode);
  const changeRequestMode = useClientSettings((settings) => settings.githubChangeRequestOpenMode);
  const referenceStyle = useClientSettings((settings) => settings.githubReferenceStyle);
  const { openExternalLinkInPreview, environmentId } = accept;
  const thread = useThreadShell(accept.threadRef ?? null);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const identity = project?.repositoryIdentity;
  // Links resolve only on github.com; an Enterprise thread's `#12` is not a github.com issue.
  const repository =
    identity?.provider === "github" &&
    identity.canonicalKey.split("/")[0] === "github.com" &&
    identity.owner &&
    identity.name
      ? { owner: identity.owner, name: identity.name }
      : null;
  const { threadRef } = accept;
  const claimPanelOpen = () => {
    if (!threadRef) return () => true;
    const revision = useRightPanelStore.getState().markUserAction(threadRef);
    return () => useRightPanelStore.getState().getUserActionRevision(threadRef) === revision;
  };

  return (() => {
    const reportFailure = (operation: string, target: string, cause: unknown): void => {
      console.error(
        "[chat-markdown] action failed",
        { operation, target } satisfies MarkdownActionFailureContext,
        cause,
      );
      if (
        operation === "link-pull-request-to-thread" ||
        operation === "unlink-pull-request-from-thread"
      ) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              operation === "link-pull-request-to-thread"
                ? "Unable to link pull request"
                : "Unable to unlink pull request",
            description: cause instanceof Error ? cause.message : "The request failed.",
          }),
        );
      }
    };

    const previewResult = async (href: string): Promise<void> => {
      const result = (await openExternalLinkInPreview(href)) as AtomLikeResult;
      if (result._tag === "Failure" && !isAtomInterrupted(result)) {
        reportFailure("open-link-in-preview", href, result.cause);
      }
    };

    const open = (
      destination: GitHubLinkDestination,
      event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
      href: string,
      openChangeRequestLink: GitHubDestinationRenderInput["openChangeRequestLink"],
    ) => {
      if (destination === "native" && openChangeRequestLink(event, href)) return;
      const api = readLocalApi();
      if (!api) {
        toastManager.add({ type: "error", title: "Link opening is unavailable." });
        return;
      }
      if (destination === "integrated") {
        void previewResult(href);
        return;
      }
      void api.shell.openExternal(href).catch((cause) => {
        console.error(
          "[chat-markdown] action failed",
          { operation: "open-link-external", target: href } satisfies MarkdownActionFailureContext,
          cause,
        );
      });
    };

    return {
      resolveHref(href) {
        return href?.startsWith(GITHUB_REFERENCE_HREF_PREFIX)
          ? resolveGitHubReferenceHref(href, repository)
          : href;
      },
      claims(href: string | undefined): boolean {
        return parseGitHubLinkTarget(href) !== null;
      },
      render(input: GitHubDestinationRenderInput): ReactNode {
        const target = parseGitHubLinkTarget(input.href);
        if (target === null) return null;
        const preferredDestination = preferredGitHubLinkDestination({
          target,
          canOpenInPreview: input.canOpenInPreview,
          linkMode,
          changeRequestMode,
        });
        const handleContextMenu = (event: MouseEvent<HTMLAnchorElement>) => {
          if (!input.href || !input.faviconHost) return;
          event.preventDefault();
          event.stopPropagation();
          const api = readLocalApi();
          if (!api) return;
          const threadLinkAction = !input.canOperateHost
            ? undefined
            : input.linkedThreadPullRequestFor(input.href) !== null
              ? "unlink-from-thread"
              : input.resolveThreadPullRequest(input.href) === null
                ? undefined
                : "link-to-thread";
          void showExternalLinkContextMenu({
            href: input.href,
            canOpenInPreview: input.canOpenInPreview,
            threadLinkAction: threadLinkAction as "unlink-from-thread" | "link-to-thread",
            position: { x: event.clientX, y: event.clientY },
            showContextMenu: (items, position) => api.contextMenu.show(items, position),
            openInPreview: previewResult,
            openExternal: (target2) => api.shell.openExternal(target2),
            copyLink: (target2) => writeTextToClipboard(target2, "link"),
            updateThreadLink: input.updateThreadPullRequestLink,
            reportFailure: (operation, cause) => {
              reportFailure(operation, input.href, cause);
            },
          });
        };
        return (
          <GitHubReferenceLink
            {...input.props}
            href={input.href}
            written={input.written}
            linkTarget={target}
            referenceStyle={referenceStyle}
            environmentId={environmentId}
            preferredDestination={preferredDestination}
            claimPanelOpen={claimPanelOpen}
            onContextMenu={handleContextMenu}
            onOpen={(destination, event, href) =>
              open(destination, event, href, input.openChangeRequestLink)
            }
          >
            {input.children}
          </GitHubReferenceLink>
        );
      },
    };
  })();
}
