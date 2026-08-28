import type { EnvironmentGitHubIssueListEntry } from "@t3tools/client-runtime/state/github-issues";

import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { GitHubIssueLabelChip, GitHubIssueTypeChip } from "./GitHubIssueChips";
import { GitHubIssueStateIcon } from "./GitHubIssueDetailPanel";
import type { GitHubIssueFilterField } from "./GitHubIssueListView.logic";

/** Beyond this the chips outgrow the row; the detail panel carries the full set. */
const VISIBLE_LABELS = 3;

export function GitHubIssueRow({
  issue,
  selected,
  showProject,
  onSelect,
  onFilter,
}: {
  readonly issue: EnvironmentGitHubIssueListEntry;
  readonly selected: boolean;
  readonly showProject: boolean;
  readonly onSelect: (issue: EnvironmentGitHubIssueListEntry) => void;
  /** Clicking a chip narrows the list to it, the way GitHub's own list behaves. */
  readonly onFilter: (field: GitHubIssueFilterField, name: string) => void;
}) {
  const issueType = issue.issueType;
  const chipped = issueType != null || issue.labels.length > 0;
  return (
    // The row is a container rather than one button, because its chips are controls in their own
    // right. Opening the issue stays a single target: the title button's overlay covers the row,
    // and the chips sit above it.
    <div
      className={cn(
        "relative grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 px-4 py-3 text-left transition-colors [contain-intrinsic-block-size:72px] [content-visibility:auto]",
        "has-[[data-row-open]:focus-visible]:ring-1 has-[[data-row-open]:focus-visible]:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <GitHubIssueStateIcon
        state={issue.state}
        className={cn(
          "mt-0.5 size-4",
          issue.state === "open" ? "text-success-foreground" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0">
        <button
          type="button"
          data-row-open
          aria-current={selected ? "true" : undefined}
          className="block w-full min-w-0 text-left after:absolute after:inset-0 focus-visible:outline-none"
          onClick={() => onSelect(issue)}
        >
          <span className="block truncate font-medium text-sm">{issue.title}</span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            <span>#{issue.number}</span>
            {showProject ? <span className="truncate">{issue.repository}</span> : null}
            {issue.author ? <span className="truncate">by {issue.author.login}</span> : null}
          </span>
        </button>
        {chipped ? (
          <span className="relative mt-1.5 flex flex-wrap items-center gap-1 text-[10px]">
            {issueType == null ? null : (
              <GitHubIssueTypeChip
                issueType={issueType}
                onFilter={() => onFilter("type", issueType.name)}
              />
            )}
            {issue.labels.slice(0, VISIBLE_LABELS).map((label) => (
              <GitHubIssueLabelChip
                key={label.name}
                label={label}
                onFilter={() => onFilter("label", label.name)}
              />
            ))}
            {issue.labels.length > VISIBLE_LABELS ? (
              <span className="text-muted-foreground">+{issue.labels.length - VISIBLE_LABELS}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      <span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
        {formatRelativeTimeLabel(issue.updatedAt)}
      </span>
    </div>
  );
}
