import type { ThreadIssueLink } from "@t3tools/contracts";
import { useRender } from "@base-ui/react/use-render";
import { CircleHelpIcon } from "lucide-react";
import type { MouseEvent, ReactElement } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { githubIssueStatePresentation } from "./githubIssuePresentation";

const UNKNOWN_PRESENTATION = {
  label: "State unknown",
  toneClassName: "text-muted-foreground",
  Icon: CircleHelpIcon,
} as const;

const linkPresentation = (link: ThreadIssueLink) =>
  link.snapshot === null
    ? UNKNOWN_PRESENTATION
    : githubIssueStatePresentation(link.snapshot.state, link.snapshot.closeReason ?? null);

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
  const presentation = linkPresentation(lead);
  return (
    <Tooltip>
      <TooltipTrigger render={control}>
        <span
          className={cn("contents font-normal text-xs tabular-nums", presentation.toneClassName)}
        >
          <presentation.Icon aria-hidden className="size-3 shrink-0" />
          <span className="text-secondary-label">
            {links.length > 1 ? `+${links.length}` : lead.number}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipPopup
        side="top"
        sideOffset={0}
        variant="glass"
        className="pointer-events-auto w-80 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
      >
        <ul className="-mx-1 flex max-h-[calc(var(--available-height)-0.5rem-2px)] flex-col gap-1 overflow-y-auto overscroll-contain px-1">
          {links.map((link) => {
            const entry = linkPresentation(link);
            return (
              <li
                key={`${link.host}/${link.repository}#${link.number}`}
                className="flex min-w-0 items-center gap-1.5 text-xs"
              >
                <entry.Icon
                  aria-label={entry.label}
                  className={cn("size-3 shrink-0", entry.toneClassName)}
                />
                <span className="shrink-0 tabular-nums text-muted-foreground">#{link.number}</span>
                <span className="min-w-0 truncate">{link.snapshot?.title ?? link.repository}</span>
              </li>
            );
          })}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
}
