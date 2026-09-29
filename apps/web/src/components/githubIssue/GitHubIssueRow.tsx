import type { EnvironmentGitHubIssueListEntry } from "@t3tools/client-runtime/state/github-issues";
import { memo } from "react";

import { cn } from "../../lib/utils";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { GitHubIssueLabelChip, GitHubIssueTypeChip } from "./GitHubIssueChips";
import { GitHubIssueCommentCount, GitHubIssueStateGlyph } from "./githubIssuePresentation";
import type { GitHubIssueFilterField } from "./GitHubIssueListView.logic";

/**
 * Each label slot past the first only appears once the meta line is wide enough to hold it, the
 * pull request row's own rule, so a narrow row shows one label and a "+N" and a wide one up to
 * three. The "+N" rides the last visible pill and hides as soon as the next slot shows.
 */
const LABEL_SLOTS = [
  { overflow: "@xl/pr-row-meta:hidden" },
  { overflow: "@3xl/pr-row-meta:hidden" },
  { overflow: "" },
] as const;

/** The pull request page row's padding and the content box a skipped row reserves. */
const PAGE_ROW_CLASS = "px-3 py-2.5 [contain-intrinsic-block-size:36.5px]";

function GitHubIssueRowImpl({
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
  return (
    // The pull request row's shape, but a container rather than one button, because its chips are
    // controls in their own right. Opening the issue stays a single target: the title button's
    // overlay covers the row, and the positioned chips sit above it.
    <div
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        PAGE_ROW_CLASS,
        "relative transition-colors [content-visibility:auto]",
        "has-[[data-row-open]:focus-visible]:ring-1 has-[[data-row-open]:focus-visible]:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <span className="flex w-4 shrink-0 flex-col items-center self-start mt-0.75">
        <GitHubIssueStateGlyph state={issue.state} />
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
        status={<GitHubIssueCommentCount count={issue.commentCount} />}
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
            {issue.labels.length > 0 ? (
              <span className="flex min-w-0 items-center gap-1">
                {LABEL_SLOTS.map((slot, index) => {
                  const label = issue.labels[index];
                  if (!label) return null;
                  const remaining = issue.labels.length - index - 1;
                  return (
                    <GitHubIssueLabelChip
                      key={label.name}
                      label={label}
                      className={
                        index === 0
                          ? ""
                          : index === 1
                            ? "hidden @xl/pr-row-meta:inline-flex"
                            : "hidden @3xl/pr-row-meta:inline-flex"
                      }
                      onFilter={() => onFilter("label", label.name)}
                    >
                      {remaining > 0 ? (
                        <span className={cn("shrink-0", slot.overflow)}>+{remaining}</span>
                      ) : null}
                    </GitHubIssueLabelChip>
                  );
                })}
              </span>
            ) : null}
          </>
        }
        updatedAt={issue.updatedAt}
      />
    </div>
  );
}

/** Memoized for the same reason the pull request row is: the route hands it a stable `onSelect`. */
export const GitHubIssueRow = memo(GitHubIssueRowImpl);
