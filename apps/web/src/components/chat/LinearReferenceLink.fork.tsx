import type { EnvironmentId } from "@t3tools/contracts";
import type { GitHubReferenceStyle } from "@t3tools/contracts/settings";
import { CircleDashedIcon } from "lucide-react";
import { useState, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";

import {
  linearIssueIdentifier,
  linearIssueSlugTitle,
  type IssueLinkTarget,
} from "./issueLinkTarget.fork";
import { ReferenceLinkPreview, useReferenceStateFork } from "./ReferenceLinkPreview.fork";
import { useReferenceReadFork, useReferenceSummaryFork } from "./referenceSummary.fork";
import { referenceAnchorProps, referenceTrigger } from "./referenceTrigger.fork";

export interface LinearReferenceLinkProps extends Omit<
  ComponentPropsWithoutRef<"a">,
  "children" | "href" | "onClick"
> {
  readonly children: ReactNode;
  readonly href: string;
  /** The link's label when it is plain text; null keeps `children` as written. */
  readonly written: string | null;
  readonly linkTarget: IssueLinkTarget;
  readonly referenceStyle: GitHubReferenceStyle;
  readonly environmentId: EnvironmentId | null;
  readonly preferredProjectId: string | null;
  readonly onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** A Linear issue link, titled by any project here that tracks Linear; else its written label. */
export function LinearReferenceLink({
  children,
  className,
  environmentId,
  href,
  linkTarget,
  onOpen,
  preferredProjectId,
  referenceStyle,
  written: writtenText,
  ...props
}: LinearReferenceLinkProps) {
  // An autolink's text is its own URL, and a bare `ENG-42` is the identifier itself.
  const identifier = linearIssueIdentifier(linkTarget);
  const written =
    writtenText && !/^https?:\/\//u.test(writtenText) && writtenText !== identifier
      ? writtenText
      : null;
  const [open, setOpen] = useState(false);
  const read = useReferenceReadFork(environmentId, href, preferredProjectId);
  const chip = writtenText !== null && referenceStyle === "chip";
  const { summary, revalidate } = useReferenceSummaryFork(read, chip || open);
  const state = useReferenceStateFork(summary);
  const title = summary?.title ?? written ?? linearIssueSlugTitle(href);
  const Icon = state?.Icon ?? CircleDashedIcon;
  const trigger = referenceTrigger({
    tracker: "linear",
    anchor: referenceAnchorProps(
      { ...props, onPointerEnter: revalidate, onFocus: revalidate },
      href,
      onOpen,
    ),
    className,
    children,
    writtenText,
    referenceStyle,
    linkLabel: written ?? identifier,
    chip: {
      icon: <Icon aria-hidden className={state?.toneClassName} />,
      label: title ?? identifier,
      detail: title ? identifier : null,
      ariaLabel: title ? `${identifier}, ${title}` : identifier,
    },
  });
  if (read === null) return trigger;
  return (
    <ReferenceLinkPreview trigger={trigger} summary={summary} open={open} onOpenChange={setOpen} />
  );
}
