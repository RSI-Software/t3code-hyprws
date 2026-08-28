import { CircleDotIcon, ExternalLinkIcon, GitPullRequestIcon, Globe2Icon } from "lucide-react";
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

function destinationLabel(destination: GitHubLinkDestination, target: GitHubLinkTarget): string {
  if (destination === "integrated") return "Open in T3 Browser";
  if (destination === "external") return "Open in external browser";
  return target.kind === "issue" ? "Open in issue panel" : "Open in pull request panel";
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
  const label = githubLinkLabel(linkTarget);

  return (
    <span className="group/github-link relative inline-flex max-w-full align-baseline">
      <a
        {...props}
        href={href}
        className={cn(
          "inline-flex min-w-0 max-w-full items-center rounded-md border border-border/65 bg-muted/30 py-px pr-6 pl-1.5 font-mono text-[0.92em] leading-[1.35] no-underline transition-colors hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
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
        {label ?? children}
      </a>
      <span className="absolute top-1/2 right-px z-10 flex -translate-y-1/2 items-center">
        {controls.map((destination) => {
          const preferred = destination === preferredDestination;
          const label = destinationLabel(destination, linkTarget);
          const button = (
            <Button
              key={destination}
              size="icon-micro"
              variant="ghost-muted"
              className={cn(
                "bg-background/95 shadow-none transition-[color,opacity,transform] duration-150",
                preferred
                  ? "text-foreground"
                  : "pointer-events-none translate-x-1 opacity-0 group-hover/github-link:pointer-events-auto group-hover/github-link:translate-x-0 group-hover/github-link:opacity-100 group-focus-within/github-link:pointer-events-auto group-focus-within/github-link:translate-x-0 group-focus-within/github-link:opacity-100",
              )}
              aria-label={label}
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
