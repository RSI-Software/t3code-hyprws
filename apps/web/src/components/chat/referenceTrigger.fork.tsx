import type { GitHubReferenceStyle } from "@t3tools/contracts/settings";
import type { ComponentPropsWithoutRef, MouseEvent, ReactElement, ReactNode } from "react";

import { ContextChip, ContextChipLabel } from "../ContextChip";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";

/** A thread-linked pull request as a chat reference shows it, from the thread's synced snapshot. */
export interface PullRequestReferenceSummary {
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed" | "draft" | "merged";
  readonly author: { readonly login: string; readonly avatarUrl: string | null } | null;
  readonly updatedAt: string;
}

export const referenceStatePresentation = (summary: PullRequestReferenceSummary) =>
  PULL_REQUEST_STATE_PRESENTATION[summary.state];

type AnchorProps = Omit<ComponentPropsWithoutRef<"a">, "children" | "href" | "onClick">;

/** A reference anchor that opens in a new tab on a modified click and calls `onOpen` otherwise. */
export function referenceAnchorProps(
  props: AnchorProps,
  href: string,
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void,
) {
  return {
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
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onOpen(event);
    },
  } satisfies ComponentPropsWithoutRef<"a">;
}

/**
 * A chat reference as written: rich markdown keeps its children, a plain one becomes a chip or a
 * short link by the reference style.
 */
export function referenceTrigger(input: {
  readonly tracker: "github" | "linear";
  readonly anchor: ComponentPropsWithoutRef<"a">;
  readonly className: string | undefined;
  readonly children: ReactNode;
  /** The link's label when it is plain text; null keeps `children` as written. */
  readonly writtenText: string | null;
  readonly referenceStyle: GitHubReferenceStyle;
  readonly linkLabel: string;
  readonly chip: {
    readonly icon: ReactNode;
    readonly label: string;
    readonly detail: string | null;
    readonly ariaLabel: string;
  };
}): ReactElement {
  const data = `data-${input.tracker}-reference`;
  if (input.writtenText === null || input.referenceStyle !== "chip") {
    return (
      <a {...input.anchor} className={input.className} {...{ [data]: "link" }}>
        {input.writtenText === null ? input.children : input.linkLabel}
      </a>
    );
  }
  return (
    <ContextChip
      kind="pull-request"
      render={<a {...input.anchor} />}
      className="no-underline"
      aria-label={input.chip.ariaLabel}
      {...{ [data]: "chip" }}
    >
      {input.chip.icon}
      <ContextChipLabel className="max-w-[28rem]">{input.chip.label}</ContextChipLabel>
      {input.chip.detail ? (
        <span className="shrink-0 text-xs font-normal text-muted-foreground">
          {input.chip.detail}
        </span>
      ) : null}
    </ContextChip>
  );
}
