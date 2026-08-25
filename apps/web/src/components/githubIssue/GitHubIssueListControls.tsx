import {
  ArrowDownWideNarrowIcon,
  ArrowUpNarrowWideIcon,
  CalendarPlusIcon,
  HistoryIcon,
  MessageSquareIcon,
  SearchIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "../../lib/utils";
import { DefaultBadge } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  DEFAULT_GITHUB_ISSUE_ORDER,
  GITHUB_ISSUE_SORTS,
  gitHubIssueDirectionLabel,
  gitHubIssueOrderIsDefault,
  type GitHubIssueDirection,
  type GitHubIssueOrder,
  type GitHubIssueSort,
} from "./GitHubIssueListView.logic";

/**
 * A control's text wears this so it drops to its icon once the list pane, the `issues` container,
 * is too narrow to carry every label. All three controls collapse together, at the one width, so
 * the row never holds a mix of spelled-out and iconic controls.
 */
export const ISSUE_CONTROL_LABEL = "@max-2xl/issues:sr-only";

/** Free-text search over the issues, sent to GitHub with the request; the filters narrow the answer. */
export function GitHubIssueSearchField({
  value,
  onChange,
  className,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly className?: string;
}) {
  return (
    <InputGroup className={cn("min-w-48 flex-1 **:[input]:h-9 sm:**:[input]:h-8", className)}>
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        type="text"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="Search issues"
        aria-label="Search GitHub issues"
      />
    </InputGroup>
  );
}

/** The dot a trigger wears once it holds something other than its default. */
function ActiveDot() {
  return (
    <span aria-hidden className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary" />
  );
}

const SORT_ICON: Record<GitHubIssueSort, ComponentType<{ className?: string }>> = {
  created: CalendarPlusIcon,
  updated: HistoryIcon,
  comments: MessageSquareIcon,
  "reactions-positive": ThumbsUpIcon,
  "reactions-negative": ThumbsDownIcon,
};

const DIRECTION_ICON: Record<GitHubIssueDirection, ComponentType<{ className?: string }>> = {
  asc: ArrowUpNarrowWideIcon,
  desc: ArrowDownWideNarrowIcon,
};

const DIRECTIONS = ["desc", "asc"] as const satisfies ReadonlyArray<GitHubIssueDirection>;

/**
 * GitHub's own two-part ordering: pick the field under "Sort by", then pick which end under
 * "Order". The trigger reads back the direction it holds, so a closed menu still says which way
 * the list runs without opening it.
 */
export function GitHubIssueOrderMenu({
  order,
  onOrder,
}: {
  readonly order: GitHubIssueOrder;
  readonly onOrder: (order: GitHubIssueOrder) => void;
}) {
  const reordered = !gitHubIssueOrderIsDefault(order);
  const DirectionIcon = DIRECTION_ICON[order.direction];
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            className={cn("relative", reordered && "[--control-icon-color:currentColor]")}
            size="sm"
            variant="outline"
          />
        }
      >
        <DirectionIcon className="size-4" />
        <span className={ISSUE_CONTROL_LABEL}>
          {gitHubIssueDirectionLabel(order.sort, order.direction)}
        </span>
        <span className="sr-only">
          , sorted by {GITHUB_ISSUE_SORTS.find((option) => option.value === order.sort)?.label}
        </span>
        {reordered ? <ActiveDot /> : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        <MenuRadioGroup
          value={order.sort}
          onValueChange={(next) => {
            if (next !== order.sort) onOrder({ ...order, sort: next as GitHubIssueSort });
          }}
        >
          <MenuGroupLabel>Sort by</MenuGroupLabel>
          {GITHUB_ISSUE_SORTS.map((option) => {
            const Icon = SORT_ICON[option.value];
            return (
              <MenuRadioItem key={option.value} value={option.value} hideIndicator closeOnClick>
                <span className="flex w-full min-w-0 items-center gap-2">
                  <Icon className="size-4" />
                  <span className="min-w-0 truncate">{option.label}</span>
                  {option.value === DEFAULT_GITHUB_ISSUE_ORDER.sort ? <DefaultBadge /> : null}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuRadioGroup
          value={order.direction}
          onValueChange={(next) => {
            if (next !== order.direction) {
              onOrder({ ...order, direction: next as GitHubIssueDirection });
            }
          }}
        >
          <MenuGroupLabel>Order</MenuGroupLabel>
          {DIRECTIONS.map((direction) => {
            const Icon = DIRECTION_ICON[direction];
            return (
              <MenuRadioItem key={direction} value={direction} hideIndicator closeOnClick>
                <span className="flex w-full min-w-0 items-center gap-2">
                  <Icon className="size-4" />
                  <span className="min-w-0 truncate">
                    {gitHubIssueDirectionLabel(order.sort, direction)}
                  </span>
                  {direction === DEFAULT_GITHUB_ISSUE_ORDER.direction ? <DefaultBadge /> : null}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
