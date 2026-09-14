import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";
import { useMemo } from "react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  CircleDotIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GithubIcon,
  GitPullRequestIcon,
  Globe2Icon,
  PanelRightIcon,
} from "lucide-react";

import { readLocalApi } from "~/localApi";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { showExternalLinkContextMenu } from "./externalLinkContextMenu";

/**
 * Fork: the GitHub link destination controls. Everything the destination
 * feature needs lives here — target parsing, the destination list, the
 * preferred-destination policy driven by the two open-mode client settings,
 * the open dispatch (native panel, integrated browser, external browser), and
 * the context menu — so `ChatMarkdown.tsx` carries only marked hook lines and
 * this file owns the behaviour.
 */

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

type GitHubLinkOpenMode = "integrated" | "external";
type GitHubChangeRequestOpenMode = "native" | "integrated" | "external";

interface GitHubDestinationLinkProps extends Omit<
  ComponentPropsWithoutRef<"a">,
  "children" | "href" | "onClick"
> {
  readonly children: ReactNode;
  readonly href: string;
  readonly linkTarget: GitHubLinkTarget;
  readonly destinations: readonly GitHubLinkDestination[];
  readonly preferredDestination: GitHubLinkDestination;
  readonly onClick?: ComponentPropsWithoutRef<"a">["onClick"];
  readonly onContextMenu?: ComponentPropsWithoutRef<"a">["onContextMenu"];
  readonly onOpen: (
    destination: GitHubLinkDestination,
    event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
  ) => void;
}

function destinationName(destination: GitHubLinkDestination, target: GitHubLinkTarget): string {
  if (destination === "integrated") return "T3 Browser";
  if (destination === "external") return "external browser";
  return target.kind === "issue" ? "issue panel" : "pull request panel";
}

function destinationLabel(destination: GitHubLinkDestination, target: GitHubLinkTarget): string {
  return `Open in ${destinationName(destination, target)}`;
}

function DestinationIcon({ destination }: { readonly destination: GitHubLinkDestination }) {
  if (destination === "integrated") return <Globe2Icon />;
  if (destination === "external") return <ExternalLinkIcon />;
  return <PanelRightIcon />;
}

function GitHubTargetIcon({ target }: { readonly target: GitHubLinkTarget }) {
  if (target.kind === "issue") return <CircleDotIcon />;
  if (target.kind === "pull-request") return <GitPullRequestIcon />;
  return <FolderGit2Icon />;
}

function hasModifier(event: MouseEvent<HTMLElement>): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

const destinationControlOrder: readonly GitHubLinkDestination[] = [
  "external",
  "integrated",
  "native",
];

function GitHubDestinationLink({
  children,
  className,
  destinations,
  href,
  linkTarget,
  onClick,
  onContextMenu,
  onOpen,
  preferredDestination,
  ...props
}: GitHubDestinationLinkProps) {
  const controls = [
    ...destinationControlOrder.filter(
      (destination) => destination !== preferredDestination && destinations.includes(destination),
    ),
    preferredDestination,
  ];
  const reference = githubLinkLabel(linkTarget) ?? linkTarget.repository;
  const childText = typeof children === "string" ? children.trim() : null;
  const showTitle = childText === null || (childText !== reference && childText !== href);
  const defaultName = destinationName(preferredDestination, linkTarget);

  return (
    <span
      className={cn(
        "group/github-link relative inline-flex max-w-full min-w-0 align-middle",
        "rounded-lg border border-border/65 bg-muted/30",
        "transition-colors duration-150 hover:border-foreground/20 hover:bg-muted/50 focus-within:border-foreground/20 focus-within:bg-muted/50",
      )}
      data-github-link-kind={linkTarget.kind}
    >
      <a
        {...props}
        href={href}
        onContextMenu={onContextMenu}
        aria-label={`Open ${reference} in ${defaultName}`}
        className={cn(
          "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-[inherit] py-[7px] pr-10 pl-2.5 text-[0.92em] leading-[1.35] text-foreground no-underline",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          linkTarget.kind === "repository"
            ? "[@media(hover:none)]:pr-[4.25rem]"
            : "[@media(hover:none)]:pr-[6.25rem]",
          className,
        )}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || hasModifier(event)) return;
          event.preventDefault();
          event.stopPropagation();
          onOpen(preferredDestination, event);
        }}
      >
        <GithubIcon className="size-4 shrink-0 text-foreground/85" aria-hidden />
        <span
          className="inline-flex shrink-0 items-center text-muted-foreground [&_svg]:size-3.5"
          aria-hidden
        >
          <GitHubTargetIcon target={linkTarget} />
        </span>
        <span className="shrink-0 font-mono font-semibold text-primary">{reference}</span>
        {showTitle ? (
          <>
            <span className="shrink-0 text-muted-foreground/50" aria-hidden>
              ·
            </span>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-foreground/85">
              {children}
            </span>
          </>
        ) : null}
      </a>
      <span
        className={cn(
          "absolute top-1/2 right-1 z-10 flex -translate-y-1/2 items-center gap-0.5",
          "before:pointer-events-none before:absolute before:inset-y-0 before:-left-6 before:right-0 before:-z-10 before:rounded-md before:bg-gradient-to-r before:from-transparent before:via-background/95 before:to-background before:opacity-0 before:transition-opacity before:duration-150",
          "group-hover/github-link:before:opacity-100 group-focus-within/github-link:before:opacity-100 [@media(hover:none)]:before:opacity-100",
        )}
        role="toolbar"
        aria-label={`Open ${reference} in another destination`}
      >
        {controls.map((destination) => {
          const preferred = destination === preferredDestination;
          const label = destinationLabel(destination, linkTarget);
          const button = (
            <Button
              key={destination}
              size="icon-micro"
              variant="ghost-muted"
              className={cn(
                "size-7 rounded-md bg-background/95 shadow-none transition-[color,opacity,transform,background-color] duration-150 [&_svg]:size-3.5",
                preferred
                  ? "text-foreground"
                  : "pointer-events-none translate-x-1 opacity-0 group-hover/github-link:pointer-events-auto group-hover/github-link:translate-x-0 group-hover/github-link:opacity-100 group-focus-within/github-link:pointer-events-auto group-focus-within/github-link:translate-x-0 group-focus-within/github-link:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:translate-x-0 [@media(hover:none)]:opacity-100",
              )}
              aria-label={`${label}${preferred ? ", default" : ""}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpen(destination, event);
              }}
            >
              <DestinationIcon destination={destination} />
            </Button>
          );
          return (
            <Tooltip key={destination}>
              <TooltipTrigger render={button} />
              <TooltipPopup side="top">
                {preferred ? `Default: ${defaultName}` : label}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </span>
    </span>
  );
}

/** What the anchor renderer hands the destination controller when it takes a link over. */
export interface GitHubDestinationRenderInput {
  readonly href: string;
  readonly props: ComponentPropsWithoutRef<"a">;
  readonly children: ReactNode;
  readonly canOpenInPreview: boolean;
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
}): {
  claims: (href: string | undefined) => boolean;
  render: (input: GitHubDestinationRenderInput) => ReactNode;
} {
  const linkMode = useClientSettings((settings) => settings.githubLinkOpenMode);
  const changeRequestMode = useClientSettings((settings) => settings.githubChangeRequestOpenMode);
  const { openExternalLinkInPreview } = accept;

  return useMemo(() => {
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
      claims(href: string | undefined): boolean {
        return parseGitHubLinkTarget(href) !== null;
      },
      render(input: GitHubDestinationRenderInput): ReactNode {
        const target = parseGitHubLinkTarget(input.href);
        if (target === null) return null;
        const destinations = githubLinkDestinations(target, input.canOpenInPreview);
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
          const threadLinkAction =
            input.linkedThreadPullRequestFor(input.href) !== null
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
          <GitHubDestinationLink
            {...input.props}
            href={input.href}
            linkTarget={target}
            destinations={destinations}
            preferredDestination={preferredDestination}
            target="_blank"
            rel="noopener noreferrer"
            onContextMenu={handleContextMenu}
            onOpen={(destination, event) =>
              open(destination, event, input.href, input.openChangeRequestLink)
            }
          >
            {input.children}
          </GitHubDestinationLink>
        );
      },
    };
  }, [linkMode, changeRequestMode, openExternalLinkInPreview]);
}
