import type { GitHubIssueLabel, GitHubIssueType } from "@t3tools/contracts";
import type { MouseEvent, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { PullRequestLabelChip } from "../pullRequest/pullRequestPresentation";
import { pullRequestLabelColor } from "../pullRequest/pullRequestList.logic";
import { gitHubIssueTypeHexColor, gitHubIssueTypeLabel } from "./githubIssueChips.logic";
import type { GitHubIssueFilterField } from "./GitHubIssueListView.logic";

/** What a type or label is called on screen; a type gains its glyph, a label is its own name. */
export function gitHubIssueChipName(kind: GitHubIssueFilterField, name: string): string {
  return kind === "type" ? gitHubIssueTypeLabel(name) : name;
}

/** The colour a type or label paints with, in the `#rrggbb` form the pull request chip reads. */
function gitHubIssueChipColor(kind: GitHubIssueFilterField, color: string | null): string | null {
  return pullRequestLabelColor(kind === "type" ? gitHubIssueTypeHexColor(color) : color);
}

/**
 * The colour alone, for a filter row that names the type or label in plain text beside it. A
 * square is a type and a circle is a label, the one place the two vocabularies still differ in
 * shape: in a chip the type's glyph already says which is which.
 */
export function GitHubIssueSwatch({
  kind,
  color,
}: {
  readonly kind: GitHubIssueFilterField;
  readonly color: string | null;
}) {
  const hex = gitHubIssueChipColor(kind, color);
  return (
    <span
      aria-hidden
      className={cn(
        "size-2.5 shrink-0",
        kind === "type" ? "rounded-xs" : "rounded-full",
        hex === null && "bg-muted-foreground/40",
      )}
      style={hex === null ? undefined : { backgroundColor: hex }}
    />
  );
}

/**
 * A type or label in the pull request surface's own label chip, so one repository's `bug` reads
 * the same on an issue as on the pull request that fixes it. As a control the chip applies itself
 * as a filter and stops the click where it lands, because the row beneath opens the issue.
 */
export function GitHubIssueChip({
  kind,
  color,
  name,
  size,
  className,
  onFilter,
  children,
}: {
  readonly kind: GitHubIssueFilterField;
  readonly color: string | null;
  readonly name: string;
  readonly size?: "sm" | "default";
  readonly className?: string;
  readonly onFilter?: () => void;
  /** Rides after the name, for an overflow count. */
  readonly children?: ReactNode;
}) {
  const label = gitHubIssueChipName(kind, name);
  const chip = (
    <PullRequestLabelChip
      label={{ name: label, color: gitHubIssueChipColor(kind, color) }}
      {...(size ? { size } : {})}
      className={cn(onFilter ? "max-w-full" : className)}
    >
      {children}
    </PullRequestLabelChip>
  );
  if (onFilter === undefined) return chip;
  return (
    <button
      type="button"
      aria-label={`Filter by ${label}`}
      className={cn(
        "relative inline-flex min-w-0 max-w-40 shrink cursor-pointer rounded-sm outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className,
      )}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        onFilter();
      }}
    >
      {chip}
    </button>
  );
}

export function GitHubIssueLabelChip({
  label,
  ...props
}: Omit<Parameters<typeof GitHubIssueChip>[0], "kind" | "color" | "name"> & {
  readonly label: GitHubIssueLabel;
}) {
  return <GitHubIssueChip kind="label" color={label.color} name={label.name} {...props} />;
}

/**
 * GitHub's native type, which is one per issue and reads ahead of the labels: a row is scanned for
 * "what kind of work is this" before it is scanned for which areas it touches.
 */
export function GitHubIssueTypeChip({
  issueType,
  ...props
}: Omit<Parameters<typeof GitHubIssueChip>[0], "kind" | "color" | "name"> & {
  readonly issueType: GitHubIssueType;
}) {
  return <GitHubIssueChip kind="type" color={issueType.color} name={issueType.name} {...props} />;
}
