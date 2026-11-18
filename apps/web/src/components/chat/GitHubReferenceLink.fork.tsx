import type { EnvironmentId } from "@t3tools/contracts";
import type { GitHubReferenceStyle } from "@t3tools/contracts/settings";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { FolderGit2Icon, GithubIcon } from "lucide-react";
import { useState, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";

import { PullRequestLinkPreview } from "../pullRequest/PullRequestLinkPreview";
import type { GitHubLinkDestination, GitHubLinkTarget } from "./GitHubDestinationLink.fork";
import { ReferenceLinkPreview, useReferenceStateFork } from "./ReferenceLinkPreview.fork";
import { useReferenceReadFork, useReferenceSummaryFork } from "./referenceSummary.fork";
import { referenceAnchorProps, referenceTrigger } from "./referenceTrigger.fork";

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
  readonly preferredProjectId: string | null;
  readonly preferredDestination: GitHubLinkDestination;
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
  preferredProjectId,
  referenceStyle,
  written: writtenText,
  ...props
}: GitHubReferenceLinkProps) {
  // An autolink's text is its own URL, which says nothing a reference doesn't.
  const written = writtenText && !/^https?:\/\//u.test(writtenText) ? writtenText : null;
  const [open, setOpen] = useState(false);
  const name = linkTarget.repository.split("/")[1];
  const numbered = linkTarget.number !== null;
  const read = useReferenceReadFork(environmentId, href, preferredProjectId);
  // An `issues/N` that read as a pull request stays one; upstream's card then reads it.
  const [promotedHref, setPromotedHref] = useState<string | null>(null);
  const promoted = promotedHref === href && read?.kind === "issue" && read.pullRequest !== null;
  // A chip names its reference by title, so it reads up front; a plain link reads on hover.
  const chip = writtenText !== null && referenceStyle === "chip";
  const { summary, revalidate } = useReferenceSummaryFork(
    read,
    numbered && (chip || (open && !promoted)),
  );
  if (!promoted && read?.kind === "issue" && summary?.kind === "pull-request") {
    setPromotedHref(href);
    setOpen(false);
  }
  const state = useReferenceStateFork(summary);
  const shortReference = numbered ? `${name}#${linkTarget.number}` : linkTarget.repository;
  // `issues/N` names a pull request too; the read picks the panel, the written URL stays.
  const panelHref = promoted
    ? (sourceControlClients.changeRequestUrlFromReferenceAutolink(href) ?? href)
    : href;
  const Icon = state?.Icon ?? (numbered ? GithubIcon : FolderGit2Icon);
  const trigger = referenceTrigger({
    tracker: "github",
    anchor: referenceAnchorProps(
      { ...props, onPointerEnter: revalidate, onFocus: revalidate },
      href,
      (event) =>
        onOpen(preferredDestination, event, preferredDestination === "native" ? panelHref : href),
    ),
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

  if (!numbered || read === null) return trigger;
  const pullRequest = read.kind === "pull-request" ? read : promoted ? read.pullRequest : null;
  if (pullRequest?.kind === "pull-request") {
    return <PullRequestLinkPreview link={trigger} originalUrl={href} target={pullRequest.target} />;
  }
  return (
    <ReferenceLinkPreview trigger={trigger} summary={summary} open={open} onOpenChange={setOpen} />
  );
}
