import type { GitHubIssueState } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon, MessageSquareIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * An issue's lifecycle in the pull request list's tones: open is the open pull request's green,
 * closed is the merged purple, because GitHub paints a completed issue the colour of landed work.
 */
export const GITHUB_ISSUE_STATE_PRESENTATION = {
  open: {
    label: "Open issue",
    toneClassName: PULL_REQUEST_STATE_PRESENTATION.open.toneClassName,
    Icon: CircleDotIcon,
  },
  closed: {
    label: "Closed issue",
    toneClassName: PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
    Icon: CircleCheckIcon,
  },
} as const satisfies Record<GitHubIssueState, unknown>;

export function GitHubIssueStateGlyph({
  state,
  className,
}: {
  readonly state: GitHubIssueState;
  readonly className?: string;
}) {
  const presentation = GITHUB_ISSUE_STATE_PRESENTATION[state];
  return (
    <Tooltip>
      {/* A span, not a button: the glyph sits inside rows that are themselves a click target. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-4 shrink-0", presentation.toneClassName, className)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

/** A discussion's size at the row's number weight, left out entirely when nobody has spoken. */
export function GitHubIssueCommentCount({ count }: { readonly count: number | undefined }) {
  if (!count) return null;
  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums text-muted-foreground"
      aria-label={`${count} ${count === 1 ? "comment" : "comments"}`}
    >
      <MessageSquareIcon aria-hidden className="size-3" />
      {count}
    </span>
  );
}
