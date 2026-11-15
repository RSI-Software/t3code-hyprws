import {
  issueKeyLabel,
  LINEAR_ISSUE_HOST,
  linearIssueSlugTitle,
  type EnvironmentId,
  type IssueLinkTarget,
} from "@t3tools/contracts";
import type { GitHubReferenceStyle } from "@t3tools/contracts/settings";
import { CircleDashedIcon } from "lucide-react";
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";

import { useServerConfigs } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";

import {
  referenceAnchorProps,
  referenceStatePresentation,
  referenceTrigger,
} from "./referenceTrigger.fork";

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
  readonly onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** A Linear issue link: its chip reads state and title when the server reads Linear, else its URL. */
export function LinearReferenceLink({
  children,
  className,
  environmentId,
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
  const serverConfigs = useServerConfigs();
  const summary = useEnvironmentQuery(
    environmentId !== null &&
      serverConfigs.get(environmentId)?.environment.capabilities.linearIssues === true &&
      referenceStyle === "chip"
      ? issueEnvironment.reference({
          environmentId,
          input: {
            host: LINEAR_ISSUE_HOST,
            repository: linkTarget.repository.toLowerCase(),
            number: linkTarget.number,
          },
        })
      : null,
  ).data;
  const state = summary ? referenceStatePresentation(summary) : null;
  const Icon = state?.Icon ?? CircleDashedIcon;
  const title = summary?.title ?? written ?? linearIssueSlugTitle(href);
  return referenceTrigger({
    tracker: "linear",
    anchor: referenceAnchorProps(props, href, onOpen),
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
}
