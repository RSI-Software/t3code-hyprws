import type { GitHubIssueLabel, GitHubIssueType } from "@t3tools/contracts";
import type { CSSProperties, MouseEvent } from "react";

import type { GitHubIssueFilterField } from "./GitHubIssueListView.logic";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import {
  gitHubChipVars,
  gitHubIssueTypeHexColor,
  gitHubIssueTypeLabel,
} from "./githubIssueChips.logic";

/**
 * Both chips are the app's own `Badge`, so they inherit its sizing, focus ring and touch target
 * instead of restating them. Only the colour and the silhouette are GitHub's, and those are
 * exported as one look so the filter rows' swatches wear the same.
 */

/**
 * The colour arrives as two custom properties and the theme picks one here, in classes rather than
 * inline, because an inline `--gh-chip` would outrank the dark variant that has to replace it.
 */
const COLOURED =
  "[--gh-chip:var(--gh-chip-light)] dark:[--gh-chip:var(--gh-chip-dark)] border-(--gh-chip)/40 text-(--gh-chip)";

/** The muted chip a label or type falls back to when GitHub sent no colour it can paint. */
const UNCOLOURED =
  "border-border bg-muted/40 text-muted-foreground dark:bg-muted/40 [button&]:hover:bg-muted/64 dark:[button&]:hover:bg-muted/64";

/**
 * A type is one per issue and is read first, so it takes the stronger silhouette: square corners
 * and a tinted fill. A label is many and secondary, so it is an outlined pill. The shape alone says
 * which vocabulary a chip belongs to, before any colour is decoded.
 */
const TYPE_SHAPE =
  "rounded-sm bg-(--gh-chip)/12 dark:bg-(--gh-chip)/16 [button&]:hover:bg-(--gh-chip)/24 dark:[button&]:hover:bg-(--gh-chip)/28";
const LABEL_SHAPE =
  "rounded-full bg-transparent dark:bg-transparent [button&]:hover:bg-(--gh-chip)/12 dark:[button&]:hover:bg-(--gh-chip)/16";

/** The one colour treatment every rendering of a type or label shares. */
export function gitHubIssueChipLook(
  kind: GitHubIssueFilterField,
  color: string | null,
): { readonly className: string; readonly style: CSSProperties | undefined } {
  const style = gitHubChipVars(kind === "type" ? gitHubIssueTypeHexColor(color) : color);
  return {
    style,
    className: cn(kind === "type" ? TYPE_SHAPE : LABEL_SHAPE, style ? COLOURED : UNCOLOURED),
  };
}

/** What a type or label is called on screen; a type gains its glyph, a label is its own name. */
export function gitHubIssueChipName(kind: GitHubIssueFilterField, name: string): string {
  return kind === "type" ? gitHubIssueTypeLabel(name) : name;
}

/**
 * The colour alone, for a list row that names the type or label in plain text beside it. Keeps the
 * chip's silhouette in miniature, so a square is a type and a circle is a label here too.
 */
export function GitHubIssueSwatch({
  kind,
  color,
}: {
  readonly kind: GitHubIssueFilterField;
  readonly color: string | null;
}) {
  const { style } = gitHubIssueChipLook(kind, color);
  return (
    <span
      aria-hidden
      className={cn(
        "size-2.5 shrink-0",
        kind === "type" ? "rounded-[3px]" : "rounded-full",
        style
          ? "[--gh-chip:var(--gh-chip-light)] dark:[--gh-chip:var(--gh-chip-dark)] bg-(--gh-chip)"
          : "bg-muted-foreground/40",
      )}
      style={style}
    />
  );
}

/**
 * A chip is static, or a control that applies itself as a filter. As a control it stops the click
 * where it lands, because a row carries its own click target and filtering by a chip must not
 * also open the issue.
 */
function chipProps(
  kind: GitHubIssueFilterField,
  color: string | null,
  name: string,
  onFilter: (() => void) | undefined,
) {
  const look = gitHubIssueChipLook(kind, color);
  return {
    style: look.style,
    lookClassName: look.className,
    ...(onFilter === undefined
      ? {}
      : {
          render: (
            <button
              type="button"
              aria-label={`Filter by ${name}`}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                onFilter();
              }}
            />
          ),
        }),
  };
}

export function GitHubIssueLabelChip({
  label,
  className,
  onFilter,
}: {
  readonly label: GitHubIssueLabel;
  readonly className?: string;
  readonly onFilter?: () => void;
}) {
  const { lookClassName, ...rest } = chipProps("label", label.color, label.name, onFilter);
  return (
    <Badge size="sm" variant="outline" className={cn(lookClassName, className)} {...rest}>
      {label.name}
    </Badge>
  );
}

/**
 * GitHub's native type, which is one per issue and reads ahead of the labels: a row is scanned for
 * "what kind of work is this" before it is scanned for which areas it touches.
 */
export function GitHubIssueTypeChip({
  issueType,
  className,
  onFilter,
}: {
  readonly issueType: GitHubIssueType;
  readonly className?: string;
  readonly onFilter?: () => void;
}) {
  const name = gitHubIssueTypeLabel(issueType.name);
  const { lookClassName, ...rest } = chipProps("type", issueType.color, name, onFilter);
  return (
    <Badge size="sm" variant="outline" className={cn(lookClassName, className)} {...rest}>
      {name}
    </Badge>
  );
}
