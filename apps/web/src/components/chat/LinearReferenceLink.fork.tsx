import { issueKeyLabel, linearIssueSlugTitle, type IssueLinkTarget } from "@t3tools/contracts";
import type { GitHubReferenceStyle } from "@t3tools/contracts/settings";
import { CircleDashedIcon } from "lucide-react";
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";

import { ContextChip, ContextChipLabel } from "../ContextChip";

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
  readonly onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** A Linear issue link. The server never reads Linear, so it shows only what its URL says. */
export function LinearReferenceLink({
  children,
  className,
  href,
  linkTarget,
  onOpen,
  referenceStyle,
  written: writtenText,
  ...props
}: LinearReferenceLinkProps) {
  // An autolink's text is its own URL, and a bare `ENG-42` is the identifier itself.
  const identifier = issueKeyLabel(linkTarget);
  const written =
    writtenText && !/^https?:\/\//u.test(writtenText) && writtenText !== identifier
      ? writtenText
      : null;
  const title = written ?? linearIssueSlugTitle(href);
  const anchorProps = {
    ...props,
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      onOpen(event);
    },
  } satisfies ComponentPropsWithoutRef<"a">;

  if (writtenText === null) {
    return (
      <a {...anchorProps} className={className} data-linear-reference="link">
        {children}
      </a>
    );
  }
  if (referenceStyle !== "chip") {
    return (
      <a {...anchorProps} className={className} data-linear-reference="link">
        {written ?? identifier}
      </a>
    );
  }
  return (
    <ContextChip
      kind="pull-request"
      render={<a {...anchorProps} />}
      className="no-underline"
      data-linear-reference="chip"
      aria-label={title ? `${identifier}, ${title}` : identifier}
    >
      <CircleDashedIcon aria-hidden />
      <ContextChipLabel className="max-w-[28rem]">{title ?? identifier}</ContextChipLabel>
      {title ? (
        <span className="shrink-0 text-xs font-normal text-muted-foreground">{identifier}</span>
      ) : null}
    </ContextChip>
  );
}
