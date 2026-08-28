import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  RefreshCwIcon,
  SquarePenIcon,
  UnlinkIcon,
} from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";

import type { SidebarThreadGroup } from "../uiStateStore";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function SidebarThreadGroupHeader(props: {
  readonly group: SidebarThreadGroup;
  readonly memberCount: number;
  readonly isGenerating: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onRename: (title: string) => void;
  readonly onRegenerate: () => void;
  readonly onRemove: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(props.group.title);
  useEffect(() => setTitle(props.group.title), [props.group.title]);

  const commitRename = () => {
    const trimmed = title.trim();
    if (trimmed) props.onRename(trimmed);
    else setTitle(props.group.title);
    setIsEditing(false);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commitRename();
    if (event.key === "Escape") {
      setTitle(props.group.title);
      setIsEditing(false);
    }
  };

  return (
    <li
      data-thread-selection-safe
      data-testid={`sidebar-thread-group-${props.group.id}`}
      className="group/thread-group mt-1 list-none px-1.5"
    >
      <div className="flex h-8 min-w-0 items-center gap-1 rounded-md border border-sidebar-border/65 bg-sidebar-accent/25 px-1.5 text-xs text-muted-foreground">
        <button
          type="button"
          aria-label={props.group.collapsed ? "Expand thread group" : "Collapse thread group"}
          aria-expanded={!props.group.collapsed}
          onClick={() => props.onCollapsedChange(!props.group.collapsed)}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {props.group.collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </button>
        <FolderIcon className="size-3.5 shrink-0" />
        {isEditing ? (
          <Input
            autoFocus
            aria-label="Thread group name"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={handleKeyDown}
            className="h-6 min-w-0 flex-1 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setIsEditing(true)}
            onClick={() => props.onCollapsedChange(!props.group.collapsed)}
            className="min-w-0 flex-1 truncate text-left font-medium text-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {props.group.title}
          </button>
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground/65">{props.memberCount}</span>
        <div
          className={cn(
            "flex shrink-0 items-center opacity-0 transition-opacity group-hover/thread-group:opacity-100 group-focus-within/thread-group:opacity-100",
            props.isGenerating && "opacity-100",
          )}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Rename thread group"
                  onClick={() => setIsEditing(true)}
                  className="inline-flex size-6 items-center justify-center rounded-sm hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <SquarePenIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Rename</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Regenerate thread group name"
                  disabled={props.isGenerating}
                  onClick={props.onRegenerate}
                  className="inline-flex size-6 items-center justify-center rounded-sm hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                />
              }
            >
              <RefreshCwIcon className={cn("size-3.5", props.isGenerating && "opacity-50")} />
            </TooltipTrigger>
            <TooltipPopup>Regenerate name</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Dissolve thread group"
                  onClick={props.onRemove}
                  className="inline-flex size-6 items-center justify-center rounded-sm hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <UnlinkIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Dissolve group</TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </li>
  );
}
