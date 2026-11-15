import type { EnvironmentId, GitHubReferenceSummary } from "@t3tools/contracts";
import type { GitHubReferenceStyle } from "@t3tools/contracts/settings";
import { ExternalLinkIcon, FolderGit2Icon, GithubIcon } from "lucide-react";
import { useState, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { issueEnvironment } from "~/state/issues";
import { useLinkedReference, useSyncStaleLinkedReference } from "~/state/linkedReferences.fork";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { InlineButton } from "../ui/button";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import type { GitHubLinkDestination, GitHubLinkTarget } from "./GitHubDestinationLink.fork";
import {
  referenceAnchorProps,
  referenceStatePresentation,
  referenceTrigger,
} from "./referenceTrigger.fork";

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
  // A thread-linked reference reads the snapshot the server keeps synced; only others ask GitHub
  // up front. An open card reads GitHub for the author and times a snapshot lacks.
  const linked = useLinkedReference(environmentId, linkTarget.repository, linkTarget.number);
  const query = useEnvironmentQuery(
    readTarget && (open || (linked === null && referenceStyle === "chip"))
      ? issueEnvironment.reference(readTarget)
      : null,
  );
  const readReference = useAtomQueryRunner(issueEnvironment.reference, {
    reportFailure: false,
    reportDefect: false,
  });
  useSyncStaleLinkedReference(environmentId, linked);
  const summary = linked?.summary ?? query.data;
  const details = query.data ?? (summary?.kind === "pull-request" ? summary : null);
  // `issues/N` names a pull request too; the read picks the panel, the written URL stays.
  const panelHref = (read: GitHubReferenceSummary | null | undefined) =>
    read && read.kind !== linkTarget.kind ? read.url : href;
  const state = summary ? referenceStatePresentation(summary) : null;
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
  const Icon = state?.Icon ?? (numbered ? GithubIcon : FolderGit2Icon);
  const trigger = referenceTrigger({
    tracker: "github",
    anchor: referenceAnchorProps(props, href, (event) => open_(preferredDestination, event)),
    className,
    children,
    writtenText,
    referenceStyle,
    linkLabel: written ?? shortReference,
    chip: {
      icon: <Icon aria-hidden className={state?.toneClassName} />,
      label: summary?.title ?? written ?? shortReference,
      detail: summary || written ? shortReference : null,
      ariaLabel: summary ? `${shortReference}, ${summary.title}` : shortReference,
    },
  });

  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger render={trigger} delay={300} closeDelay={150} />
      <PreviewCardPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="p-3">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {details?.ownerAvatarUrl ? (
              <img
                aria-hidden
                alt=""
                src={details.ownerAvatarUrl}
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
          {details ? (
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {details.author ? (
                <>
                  <PullRequestActorAvatar
                    actor={{ ...details.author, name: null }}
                    className="size-4"
                  />
                  <span className="truncate">{details.author.login}</span>
                  <span aria-hidden>·</span>
                </>
              ) : null}
              <span className="shrink-0">
                updated <RelativeTime timestamp={details.updatedAt} />
              </span>
            </div>
          ) : null}
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
