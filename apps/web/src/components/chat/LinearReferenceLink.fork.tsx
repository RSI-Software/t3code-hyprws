import { issueKeyLabel, linearIssueSlugTitle, type IssueLinkTarget } from "@t3tools/contracts";
import type { GitHubReferenceStyle } from "@t3tools/contracts/settings";
import { CircleDashedIcon } from "lucide-react";
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";

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
  return referenceTrigger({
    tracker: "linear",
    anchor: referenceAnchorProps(props, href, onOpen),
    className,
    children,
    writtenText,
    referenceStyle,
    linkLabel: written ?? identifier,
    chip: {
      icon: <CircleDashedIcon aria-hidden />,
      label: title ?? identifier,
      detail: title ? identifier : null,
      ariaLabel: title ? `${identifier}, ${title}` : identifier,
    },
  });
}
