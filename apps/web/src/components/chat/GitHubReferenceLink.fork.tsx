import type { EnvironmentId, GitHubReferenceSummary } from "@t3tools/contracts";
import type { GitHubReferenceStyle } from "@t3tools/contracts/settings";
import { ExternalLinkIcon, FolderGit2Icon, GithubIcon } from "lucide-react";
import { useState, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { ContextChip, ContextChipLabel } from "../ContextChip";
import {
  ISSUE_NOT_PLANNED_PRESENTATION,
  ISSUE_STATE_PRESENTATION,
} from "../issues/issuePresentation";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { InlineButton } from "../ui/button";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import type { GitHubLinkDestination, GitHubLinkTarget } from "./GitHubDestinationLink.fork";

function statePresentation(summary: GitHubReferenceSummary) {
  if (summary.kind === "pull-request") {
    return summary.state === "not-planned"
      ? PULL_REQUEST_STATE_PRESENTATION.closed
      : PULL_REQUEST_STATE_PRESENTATION[summary.state];
  }
  if (summary.state === "open") return ISSUE_STATE_PRESENTATION.open;
  return summary.state === "closed"
    ? ISSUE_STATE_PRESENTATION.closed
    : ISSUE_NOT_PLANNED_PRESENTATION;
}

function hasModifier(event: MouseEvent<HTMLElement>): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

export interface GitHubReferenceLinkProps extends Omit<
  ComponentPropsWithoutRef<"a">,
  "children" | "href" | "onClick"
> {
  readonly children: ReactNode;
  readonly href: string;
  /** The link's label when it is plain text; null keeps `children` as written. */
  readonly written: string | null;
  readonly linkTarget: GitHubLinkTarget;
  readonly referenceStyle: GitHubReferenceStyle;
  readonly environmentId: EnvironmentId | null;
  readonly preferredDestination: GitHubLinkDestination;
  /** Claims the panel for a late open; the check fails once a newer panel choice lands. */
  readonly claimPanelOpen: () => () => boolean;
  readonly onOpen: (
    destination: GitHubLinkDestination,
    event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
    href: string,
  ) => void;
}

export function GitHubReferenceLink({
  children,
  className,
  environmentId,
  href,
  linkTarget,
  onOpen,
  preferredDestination,
  referenceStyle,
  claimPanelOpen,
  written: writtenText,
  ...props
}: GitHubReferenceLinkProps) {
  // An autolink's text is its own URL, which says nothing a reference doesn't.
  const written = writtenText && !/^https?:\/\//u.test(writtenText) ? writtenText : null;
  const [open, setOpen] = useState(false);
  const name = linkTarget.repository.split("/")[1];
  const numbered = linkTarget.number !== null;
  // A titled chip needs its title up front; a plain link reads only once its card opens.
  const readTarget =
    numbered && environmentId !== null
      ? {
          environmentId,
          input: {
            host: "github.com",
            repository: linkTarget.repository,
            number: linkTarget.number!,
          },
        }
      : null;
  const query = useEnvironmentQuery(
    readTarget && (referenceStyle === "chip" || open)
      ? issueEnvironment.reference(readTarget)
      : null,
  );
  const readReference = useAtomQueryRunner(issueEnvironment.reference, {
    reportFailure: false,
    reportDefect: false,
  });
  const summary = query.data;
  // `issues/N` names a pull request too; the read picks the panel, the written URL stays.
  const panelHref = (read: GitHubReferenceSummary | null | undefined) =>
    read && read.kind !== linkTarget.kind ? read.url : href;
  const state = summary ? statePresentation(summary) : null;
  const shortReference = numbered ? `${name}#${linkTarget.number}` : linkTarget.repository;

  const open_ = (
    destination: GitHubLinkDestination,
    event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
  ) => {
    // An unread `issues/N` may be a pull request; ask before choosing the panel.
    if (destination !== "native") {
      onOpen(destination, event, href);
      return;
    }
    if (summary || readTarget === null || linkTarget.kind !== "issue") {
      onOpen(destination, event, panelHref(summary));
      return;
    }
    const stillCurrent = claimPanelOpen();
    void readReference(readTarget).then((result) => {
      if (!stillCurrent()) return;
      onOpen(destination, event, panelHref(result._tag === "Success" ? result.value : null));
    });
  };
  const anchorProps = {
    ...props,
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || hasModifier(event)) return;
      event.preventDefault();
      event.stopPropagation();
      open_(preferredDestination, event);
    },
  } satisfies ComponentPropsWithoutRef<"a">;

  const Icon = state?.Icon ?? (numbered ? GithubIcon : FolderGit2Icon);
  const trigger =
    writtenText === null ? (
      <a {...anchorProps} className={className} data-github-reference="link">
        {children}
      </a>
    ) : referenceStyle === "chip" ? (
      <ContextChip
        kind="pull-request"
        render={<a {...anchorProps} />}
        className="no-underline"
        data-github-reference="chip"
        aria-label={summary ? `${shortReference}, ${summary.title}` : shortReference}
      >
        <Icon aria-hidden className={state?.toneClassName} />
        <ContextChipLabel className="max-w-[28rem]">
          {summary?.title ?? written ?? shortReference}
        </ContextChipLabel>
        {summary || written ? (
          <span className="shrink-0 text-xs font-normal text-muted-foreground">
            {shortReference}
          </span>
        ) : null}
      </ContextChip>
    ) : (
      <a {...anchorProps} className={className} data-github-reference="link">
        {written ?? shortReference}
      </a>
    );

  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger render={trigger} delay={300} closeDelay={150} />
      <PreviewCardPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="p-3">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {summary?.ownerAvatarUrl ? (
              <img
                aria-hidden
                alt=""
                src={summary.ownerAvatarUrl}
                className="size-4 shrink-0 rounded-sm bg-muted object-cover"
              />
            ) : (
              <GithubIcon aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate">{linkTarget.repository}</span>
            <InlineButton
              aria-label={`Open ${linkTarget.repository}${numbered ? `#${linkTarget.number}` : ""} on GitHub`}
              onClick={(event) => {
                setOpen(false);
                onOpen("external", event, href);
              }}
            >
              {numbered ? <span className={state?.toneClassName}>#{linkTarget.number}</span> : null}
              <ExternalLinkIcon aria-hidden className="size-2.5" />
            </InlineButton>
            {state ? (
              <state.Icon
                role="img"
                aria-label={state.label}
                className={`ml-auto size-3.5 shrink-0 ${state.toneClassName}`}
              />
            ) : null}
          </div>
          {numbered ? (
            <p className="mt-1.5 text-sm font-medium leading-snug text-foreground text-pretty">
              {summary?.title ??
                (query.isPending
                  ? "Loading…"
                  : query.error
                    ? "Couldn't read this from GitHub"
                    : "Not found on GitHub")}
            </p>
          ) : null}
          {summary ? (
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {summary.author ? (
                <>
                  <PullRequestActorAvatar
                    actor={{ ...summary.author, name: null }}
                    className="size-4"
                  />
                  <span className="truncate">{summary.author.login}</span>
                  <span aria-hidden>·</span>
                </>
              ) : null}
              <span className="shrink-0">
                updated <RelativeTime timestamp={summary.updatedAt} />
              </span>
            </div>
          ) : null}
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
