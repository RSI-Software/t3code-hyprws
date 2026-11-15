import {
  isLinearIssueKey,
  issueKeyLabel,
  issueKeySource,
  linearIssueSlugTitle,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { useRender } from "@base-ui/react/use-render";
import { CircleDashedIcon, CircleHelpIcon, ListTreeIcon } from "lucide-react";
import type { MouseEvent, ReactElement } from "react";

import { cn } from "../../lib/utils";
import { LinkedBadgeTooltipPopupFork } from "../LinkedBadgeTooltipPopup.fork";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { issueStatePresentation } from "./issuePresentation";
import { subIssueProgress } from "./threadIssueTree.logic";

const UNKNOWN_PRESENTATION = {
  label: "State unknown",
  toneClassName: "text-muted-foreground",
  Icon: CircleHelpIcon,
} as const;

// The server never reads Linear, so a Linear link has no state to show.
const LINEAR_PRESENTATION = {
  label: "Linear issue",
  toneClassName: "text-muted-foreground",
  Icon: CircleDashedIcon,
} as const;

export const threadIssueLinkPresentation = (link: ThreadIssueLink) =>
  link.snapshot !== null
    ? issueStatePresentation(link.snapshot.state, link.snapshot.closeReason ?? null)
    : isLinearIssueKey(link)
      ? LINEAR_PRESENTATION
      : UNKNOWN_PRESENTATION;

/** A link's title: its last read, else a Linear URL's slug, else null. */
export const threadIssueLinkTitle = (link: ThreadIssueLink): string | null =>
  link.snapshot?.title ?? linearIssueSlugTitle(link.url);

/** A linked issue's closed and total sub-issues, absent for an issue without any. */
export function ThreadIssueSubIssueProgressFork({ link }: { readonly link: ThreadIssueLink }) {
  const progress = subIssueProgress(link);
  if (progress === null) return null;
  return (
    <span
      aria-label={`${progress.closed} of ${progress.total} sub-issues closed`}
      className="inline-flex shrink-0 items-center gap-0.5 font-normal text-2xs tabular-nums text-muted-foreground"
    >
      <ListTreeIcon aria-hidden className="size-3" />
      {progress.closed}/{progress.total}
    </span>
  );
}

/**
 * The linked-issue twin of the thread pull request badge: the first open link's glyph and number,
 * a count of the rest, and every link on hover. A click opens the thread's Linked issues tab.
 */
export function ThreadIssueBadgeFork({
  render,
  issues,
  onOpenList,
}: {
  readonly render: ReactElement<{ render?: useRender.RenderProp }>;
  readonly issues: ReadonlyArray<ThreadIssueLink> | undefined;
  readonly onOpenList: () => void;
}) {
  const links = issues ?? [];
  const lead =
    links.find((link) => link.snapshot === null || link.snapshot.state === "open") ?? links[0];
  const control = useRender({
    render,
    props: {
      render: <button type="button" />,
      "aria-label": `${links.length} linked issue${links.length === 1 ? "" : "s"}`,
      onPointerDown: (event: MouseEvent<HTMLElement>) => event.stopPropagation(),
      onClick: (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenList();
      },
    },
  });
  if (lead === undefined) return null;
  const presentation = threadIssueLinkPresentation(lead);
  return (
    <Tooltip>
      <TooltipTrigger render={control}>
        <span
          className={cn("contents font-normal text-xs tabular-nums", presentation.toneClassName)}
        >
          <presentation.Icon aria-hidden className="size-3 shrink-0" />
          <span className="text-secondary-label">
            {links.length > 1 ? `+${links.length}` : issueKeyLabel(lead).replace(/^#/u, "")}
          </span>
        </span>
      </TooltipTrigger>
      <LinkedBadgeTooltipPopupFork>
        <ThreadIssuesMiniListFork issues={links} />
      </LinkedBadgeTooltipPopupFork>
    </Tooltip>
  );
}

/** The linked-issue twin of the thread pull request mini list. */
function ThreadIssuesMiniListFork({
  issues,
}: {
  readonly issues: ReadonlyArray<ThreadIssueLink> | undefined;
}) {
  if (!issues?.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((link) => {
        const entry = threadIssueLinkPresentation(link);
        return (
          <li
            key={`${link.host}/${link.repository}#${link.number}`}
            className="flex min-w-0 items-center gap-2"
          >
            <entry.Icon
              aria-label={entry.label}
              className={cn("size-3 shrink-0", entry.toneClassName)}
            />
            <span className="shrink-0 font-mono tabular-nums">{issueKeyLabel(link)}</span>
            <span className="min-w-0 truncate text-foreground/75">
              {threadIssueLinkTitle(link) ?? issueKeySource(link)}
            </span>
            <ThreadIssueSubIssueProgressFork link={link} />
          </li>
        );
      })}
    </ul>
  );
}

/** Linked issues in the sidebar thread hover card, ruled off like its pull request footer. */
export function ThreadHoverCardIssuesFork({
  issues,
}: {
  readonly issues: ReadonlyArray<ThreadIssueLink> | undefined;
}) {
  if (!issues?.length) return null;
  return (
    <div className="-ml-0.5 mt-0.5 min-w-0 border-t border-border/60 pt-2 pl-0.5">
      <ThreadIssuesMiniListFork issues={issues} />
    </div>
  );
}
