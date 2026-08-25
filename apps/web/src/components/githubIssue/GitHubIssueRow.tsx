import type { EnvironmentGitHubIssueListEntry } from "@t3tools/client-runtime/state/github-issues";

import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { GitHubIssueStateIcon } from "./GitHubIssueDetailPanel";

export function GitHubIssueRow({
  issue,
  selected,
  showProject,
  onSelect,
}: {
  readonly issue: EnvironmentGitHubIssueListEntry;
  readonly selected: boolean;
  readonly showProject: boolean;
  readonly onSelect: (issue: EnvironmentGitHubIssueListEntry) => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 px-4 py-3 text-left transition-colors [contain-intrinsic-block-size:72px] [content-visibility:auto] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
      onClick={() => onSelect(issue)}
    >
      <GitHubIssueStateIcon
        state={issue.state}
        className={cn(
          "mt-0.5 size-4",
          issue.state === "open" ? "text-success-foreground" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{issue.title}</span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <span>#{issue.number}</span>
          {showProject ? <span className="truncate">{issue.repository}</span> : null}
          {issue.author ? <span className="truncate">by {issue.author.login}</span> : null}
        </span>
        {issue.labels.length > 0 ? (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {issue.labels.slice(0, 3).map((label) => (
              <span
                key={label.name}
                className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {label.name}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
        {formatRelativeTimeLabel(issue.updatedAt)}
      </span>
    </button>
  );
}
