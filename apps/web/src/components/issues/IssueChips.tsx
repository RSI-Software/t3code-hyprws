import type { IssueLabel, GitHubIssueType } from "@t3tools/contracts";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { PullRequestLabelChip } from "../pullRequest/pullRequestPresentation";
import { pullRequestLabelColor } from "../pullRequest/pullRequestList.logic";
import { gitHubIssueTypeHexColor, gitHubIssueTypeLabel } from "./issueChips.logic";
import type { IssueFilterField } from "./IssueListView.logic";

/** What a type or label is called on screen; a type gains its glyph, a label is its own name. */
export function issueChipName(kind: IssueFilterField, name: string): string {
  return kind === "type" ? gitHubIssueTypeLabel(name) : name;
}

/** The colour a type or label paints with, in the `#rrggbb` form the pull request chip reads. */
function issueChipColor(kind: IssueFilterField, color: string | null): string | null {
  return pullRequestLabelColor(kind === "type" ? gitHubIssueTypeHexColor(color) : color);
}

/**
 * The colour alone, for a filter row that names the type or label in plain text beside it. A
 * square is a type and a circle is a label, the one place the two vocabularies still differ in
 * shape: in a chip the type's glyph already says which is which.
 */
export function IssueSwatch({
  kind,
  color,
}: {
  readonly kind: IssueFilterField;
  readonly color: string | null;
}) {
  const hex = issueChipColor(kind, color);
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
export function IssueChip({
  kind,
  color,
  name,
  size,
  className,
  onFilter,
  children,
}: {
  readonly kind: IssueFilterField;
  readonly color: string | null;
  readonly name: string;
  readonly size?: "sm" | "default";
  readonly className?: string;
  readonly onFilter?: () => void;
  /** Rides after the name, for an overflow count. */
  readonly children?: ReactNode;
}) {
  const label = issueChipName(kind, name);
  const hex = issueChipColor(kind, color);
  if (onFilter !== undefined) {
    return (
      <Badge
        size={size ?? "sm"}
        variant={hex ? "label" : "secondary"}
        className={cn("min-w-0 max-w-40 shrink justify-start", className)}
        {...(hex ? { style: { "--label": hex } as CSSProperties } : {})}
        render={
          <button
            type="button"
            aria-label={`Filter by ${label}`}
            onClick={(event) => {
              event.stopPropagation();
              onFilter();
            }}
          />
        }
      >
        <span className="truncate">{label}</span>
        {children}
      </Badge>
    );
  }
  return (
    <PullRequestLabelChip
      label={{ name: label, color: hex }}
      {...(size ? { size } : {})}
      className={cn(className)}
    >
      {children}
    </PullRequestLabelChip>
  );
}

export function IssueLabelChip({
  label,
  ...props
}: Omit<Parameters<typeof IssueChip>[0], "kind" | "color" | "name"> & {
  readonly label: IssueLabel;
}) {
  return <IssueChip kind="label" color={label.color} name={label.name} {...props} />;
}

/**
 * GitHub's native type, which is one per issue and reads ahead of the labels: a row is scanned for
 * "what kind of work is this" before it is scanned for which areas it touches.
 */
export function GitHubIssueTypeChip({
  issueType,
  ...props
}: Omit<Parameters<typeof IssueChip>[0], "kind" | "color" | "name"> & {
  readonly issueType: GitHubIssueType;
}) {
  return <IssueChip kind="type" color={issueType.color} name={issueType.name} {...props} />;
}

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

export function IssueLabelChips({
  labels,
  onFilter,
}: {
  readonly labels: ReadonlyArray<IssueLabel>;
  readonly onFilter?: (name: string) => void;
}) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {LABEL_SLOTS.map((slot, index) => {
        const label = labels[index];
        if (!label) return null;
        const remaining = labels.length - index - 1;
        return (
          <IssueLabelChip
            key={label.name}
            label={label}
            className={
              index === 0
                ? ""
                : index === 1
                  ? "hidden @xl/pr-row-meta:inline-flex"
                  : "hidden @3xl/pr-row-meta:inline-flex"
            }
            {...(onFilter ? { onFilter: () => onFilter(label.name) } : {})}
          >
            {remaining > 0 ? (
              <span className={cn("shrink-0", slot.overflow)}>+{remaining}</span>
            ) : null}
          </IssueLabelChip>
        );
      })}
    </span>
  );
}
