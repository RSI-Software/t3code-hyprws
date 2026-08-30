import {
  ChevronDownIcon,
  ChevronRightIcon,
  Layers3Icon,
  RefreshCwIcon,
  SquarePenIcon,
  UnlinkIcon,
} from "lucide-react";
import { useEffect, useState, type CSSProperties, type Ref } from "react";

import type { SidebarThreadGroup } from "../uiStateStore";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { SidebarRenameInput } from "./SidebarRenameInput";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function SidebarThreadGroupHeader(props: {
  readonly group: SidebarThreadGroup;
  readonly memberCount: number;
  readonly isGenerating: boolean;
  readonly isGroupDropTarget?: boolean;
  readonly isDissolving?: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onRename: (title: string) => void;
  readonly onRegenerate: () => void;
  readonly onRemove: () => void;
  readonly rootRef?: Ref<HTMLLIElement>;
  readonly rootStyle?: CSSProperties;
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
  const cancelRename = () => {
    setTitle(props.group.title);
    setIsEditing(false);
  };

  return (
    <li
      ref={props.rootRef}
      style={props.rootStyle}
      data-thread-selection-safe
      data-group-dissolving={props.isDissolving || undefined}
      data-testid={`sidebar-thread-group-${props.group.id}`}
      className={cn(
        "group/thread-group mt-1 list-none px-1.5",
        props.isDissolving && "pointer-events-none mt-0 overflow-hidden",
      )}
    >
      <div
        data-group-drop-target={props.isGroupDropTarget || undefined}
        className={cn(
          "relative flex h-8 min-w-0 items-center gap-1 rounded-md border border-sidebar-border/65 bg-sidebar-accent/25 px-1.5 pr-3 text-xs text-muted-foreground transition-[height,opacity,background-color,border-color] duration-150 ease-out",
          props.isGroupDropTarget &&
            "border-sidebar-ring bg-sidebar-accent/60 ring-2 ring-sidebar-ring",
          props.isDissolving && "h-0 opacity-0",
        )}
      >
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
        <Layers3Icon aria-hidden className="size-3.5 shrink-0" />
        {isEditing ? (
          <SidebarRenameInput
            ariaLabel="Thread group title"
            value={title}
            onValueChange={setTitle}
            onCommit={commitRename}
            onCancel={cancelRename}
            className="h-6 text-xs"
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
        <Badge
          variant="secondary"
          size="sm"
          aria-label={`${props.memberCount} threads`}
          className="pointer-events-none absolute -right-0.5 -top-1 z-10 h-3.5 min-w-3.5 rounded-full px-0.5 font-sans text-[0.5625rem] font-normal leading-none text-muted-foreground tabular-nums ring-1 ring-sidebar-background"
        >
          {props.memberCount}
        </Badge>
        <div
          className={cn(
            "flex w-18 shrink-0 items-center opacity-0 transition-opacity group-hover/thread-group:opacity-100 group-focus-within/thread-group:opacity-100",
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
