import type { EnvironmentIssueListEntry } from "@t3tools/client-runtime/state/issues";
import { memo } from "react";

import { cn } from "../../lib/utils";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { IssueLabelChips, GitHubIssueTypeChip } from "./IssueChips";
import { IssueCommentCount, IssueStateGlyph } from "./issuePresentation";
import type { IssueFilterField } from "./IssueListView.logic";

/** The pull request page row's padding and the content box a skipped row reserves. */
const PAGE_ROW_CLASS = "px-3 py-2.5 [contain-intrinsic-block-size:36.5px]";

function IssueRowImpl({
  issue,
  selected,
  showProject,
  onSelect,
  onFilter,
}: {
  readonly issue: EnvironmentIssueListEntry;
  readonly selected: boolean;
  readonly showProject: boolean;
  readonly onSelect: (issue: EnvironmentIssueListEntry) => void;
  /** Clicking a chip narrows the list to it, the way GitHub's own list behaves. */
  readonly onFilter: (field: IssueFilterField, name: string) => void;
}) {
  const issueType = issue.issueType;
  return (
    // The pull request row's shape, but a container rather than one button, because its chips are
    // controls in their own right. Opening the issue stays a single target: the title button's
    // overlay covers the row, and the positioned chips sit above it.
    <div
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        PAGE_ROW_CLASS,
        "relative transition-colors [content-visibility:auto]",
        "has-[[data-row-open]:focus-visible]:ring-1 has-[[data-row-open]:focus-visible]:ring-ring has-[[data-row-open]:focus-visible]:ring-inset",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <span className="flex w-4 shrink-0 flex-col items-center self-start mt-0.75">
        <IssueStateGlyph state={issue.state} closeReason={issue.closeReason ?? null} />
      </span>
      <PullRequestRowLines
        number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{issue.number}</span>}
        title={
          <button
            type="button"
            data-row-open
            aria-current={selected ? "true" : undefined}
            className="cursor-pointer text-left after:absolute after:inset-0 after:rounded-md focus-visible:outline-none"
            onClick={() => onSelect(issue)}
          >
            {issue.title}
          </button>
        }
        status={<IssueCommentCount count={issue.commentCount} />}
        metaClassName="@container/pr-row-meta"
        meta={
          <>
            <PullRequestRowAuthor
              actor={issue.author}
              className="relative min-w-3.5 max-w-40"
              labelClassName="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate"
            />
            {showProject ? <span className="truncate">{issue.repository}</span> : null}
            {issueType == null ? null : (
              <GitHubIssueTypeChip
                issueType={issueType}
                // The type is the row's one fact about kind of work, so labels give way first.
                className="shrink-0"
                onFilter={() => onFilter("type", issueType.name)}
              />
            )}
            <IssueLabelChips labels={issue.labels} onFilter={(name) => onFilter("label", name)} />
          </>
        }
        updatedAt={issue.updatedAt}
      />
    </div>
  );
}

/** Memoized for the same reason the pull request row is: the route hands it a stable `onSelect`. */
export const IssueRow = memo(IssueRowImpl);
