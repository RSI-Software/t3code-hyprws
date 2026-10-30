import type { ScopedThreadRef, ThreadIssueLink } from "@t3tools/contracts";
import { ChevronDown, ChevronUp } from "lucide";
import { useState } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "../chat/threadDetailsPanelStyles";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { threadIssueLinkPresentation } from "./ThreadIssueBadge.fork";

const linkKey = (link: ThreadIssueLink) => `${link.host}/${link.repository}#${link.number}`;

/**
 * Linked issues under the thread-details pull request rows: the lead open issue, the rest behind
 * the same Show more toggle. A row opens the issue in the right panel.
 */
export function ThreadDetailsIssueRowsFork({
  threadRef,
  issues,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly issues: ReadonlyArray<ThreadIssueLink> | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const openLink = useOpenPrLink(threadRef);
  const links = issues ?? [];
  const lead =
    links.find((link) => link.snapshot === null || link.snapshot.state === "open") ?? links[0];
  if (lead === undefined) return null;
  const rest = links.filter((link) => link !== lead);

  const row = (link: ThreadIssueLink) => {
    const presentation = threadIssueLinkPresentation(link);
    return (
      <Tooltip key={linkKey(link)}>
        <TooltipTrigger
          render={
            <ThreadDetailsControl
              type="button"
              variant="ghost"
              size="sm"
              part="row"
              aria-label={link.url}
              onClick={(event) => openLink(event, link.url, threadRef)}
              onAuxClick={(event) => openLink(event, link.url, threadRef)}
            />
          }
        >
          <presentation.Icon
            aria-hidden
            className={cn("size-4 shrink-0", presentation.toneClassName)}
          />
          <span
            className={cn("min-w-0 flex-1 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}
          >
            #{link.number}
            {link.snapshot === null ? "" : `: ${link.snapshot.title}`}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {presentation.label} · {link.repository}#{link.number}
        </TooltipPopup>
      </Tooltip>
    );
  };

  return (
    <>
      {row(lead)}
      {expanded ? <div className="flex flex-col">{rest.map(row)}</div> : null}
      {rest.length > 0 ? (
        <ThreadDetailsControl
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          part="row"
          tone="muted"
          className="w-full active:scale-100"
        >
          <MorphIcon
            aria-hidden
            className="size-4 shrink-0"
            icon={expanded ? ChevronUp : ChevronDown}
          />
          {expanded ? "Show less" : `Show ${rest.length} more`}
        </ThreadDetailsControl>
      ) : null}
    </>
  );
}
