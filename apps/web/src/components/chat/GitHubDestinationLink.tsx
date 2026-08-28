import {
  CircleDotIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GithubIcon,
  GitPullRequestIcon,
  Globe2Icon,
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

function DestinationIcon({
  destination,
  target,
}: {
  readonly destination: GitHubLinkDestination;
  readonly target: GitHubLinkTarget;
}) {
  if (destination === "integrated") return <Globe2Icon />;
  if (destination === "external") return <ExternalLinkIcon />;
  return target.kind === "issue" ? <CircleDotIcon /> : <GitPullRequestIcon />;
}

function GitHubTargetIcon({ target }: { readonly target: GitHubLinkTarget }) {
  if (target.kind === "issue") return <CircleDotIcon />;
  if (target.kind === "pull-request") return <GitPullRequestIcon />;
  return <FolderGit2Icon />;
}

function hasModifier(event: MouseEvent<HTMLElement>): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

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
    ...destinations.filter((destination) => destination !== preferredDestination),
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
        "before:absolute before:top-1.5 before:bottom-1.5 before:-left-px before:w-0.5 before:rounded-r-full before:bg-transparent",
        "transition-colors duration-150 hover:border-primary/35 hover:bg-accent hover:before:bg-primary focus-within:border-primary/35 focus-within:bg-accent focus-within:before:bg-primary",
      )}
      data-github-link-kind={linkTarget.kind}
    >
      <a
        {...props}
        href={href}
        aria-label={`Open ${reference} in ${defaultName}`}
        className={cn(
          "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-[inherit] px-2.5 py-[7px] text-[0.92em] leading-[1.35] text-foreground no-underline",
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
        <span
          className="ml-auto inline-grid size-[22px] shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5"
          title={`Default: ${defaultName}`}
          aria-hidden
        >
          <DestinationIcon destination={preferredDestination} target={linkTarget} />
        </span>
      </a>
      <span
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 z-10 flex translate-x-1 items-center gap-0.5 overflow-hidden rounded-r-[inherit] border-l border-border/65 bg-accent px-1 opacity-0",
          "transition-[opacity,transform] duration-150",
          "group-hover/github-link:pointer-events-auto group-hover/github-link:translate-x-0 group-hover/github-link:opacity-100",
          "group-focus-within/github-link:pointer-events-auto group-focus-within/github-link:translate-x-0 group-focus-within/github-link:opacity-100",
          "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:translate-x-0 [@media(hover:none)]:opacity-100",
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
                "relative size-8 rounded-md bg-transparent shadow-none [&_svg]:size-4",
                preferred &&
                  "text-foreground after:absolute after:right-1 after:bottom-1 after:size-1 after:rounded-full after:bg-primary after:content-['']",
              )}
              aria-label={`${label}${preferred ? ", default" : ""}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpen(destination, event);
              }}
            >
              <DestinationIcon destination={destination} target={linkTarget} />
            </Button>
          );
          return (
            <Tooltip key={destination}>
              <TooltipTrigger render={button} />
              <TooltipPopup side="top">{label}</TooltipPopup>
            </Tooltip>
          );
        })}
      </span>
    </span>
  );
}
