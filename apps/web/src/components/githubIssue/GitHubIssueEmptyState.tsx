import type { ReactNode } from "react";

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

/**
 * The pull request list draws an unjoined branch; the issue list draws the issue glyph with its
 * centre missing, in the same stroke weight, so an empty page reads as the same surface with
 * nothing on it rather than as a stock empty box.
 */
function IssueMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 72"
      className="h-20 w-32 text-muted-foreground/60"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <path d="M10 58h100" className="text-muted-foreground/30" stroke="currentColor" />
      <circle cx="60" cy="32" r="20" />
      <circle
        cx="60"
        cy="32"
        r="5"
        strokeDasharray="2 5"
        className="text-muted-foreground/45"
        stroke="currentColor"
      />
    </svg>
  );
}

export function GitHubIssueEmptyState({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <Empty>
      <IssueMark />
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
