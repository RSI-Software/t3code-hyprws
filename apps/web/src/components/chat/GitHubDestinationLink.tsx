import {
  CircleDotIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GithubIcon,
  GitPullRequestIcon,
  Globe2Icon,
  PanelRightIcon,
} from "lucide-react";
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  githubLinkLabel,
  type GitHubLinkDestination,
  type GitHubLinkTarget,
} from "./githubLinkDestinations";

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

export function GitHubDestinationLink({
  children,
  className,
  destinations,
  href,
  linkTarget,
  onClick,
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
