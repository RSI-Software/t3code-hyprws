import { useDndContext, useDndMonitor } from "@dnd-kit/core";
import {
  ChevronDownIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SquarePenIcon,
  UnlinkIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { SidebarThreadGroup } from "../uiStateStore";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { sidebarMarkerId, type SidebarListItem } from "./Sidebar.logic";
import { SidebarRenameInput } from "./SidebarRenameInput";
import {
  sidebarThreadGroupHeaderMarker,
  type SidebarThreadGroupSpan,
} from "./SidebarThreadGroup.markers";
import {
  SIDEBAR_THREAD_GROUP_INDENT,
  type SidebarThreadGroupProjection,
} from "./SidebarThreadGroup.projection";
import { sidebarProjectedLayoutFork } from "./SidebarThreadGroup.span";

// Mirrors upstream's shelf section header (Snoozed / Settled): label with the
// count, a hairline, and a chevron, reading at full strength during a drag. It
// renders inside the group's sortable header marker, so it moves with the rows
// during a drag; the drop layer draws the outline when a row would join it.
export function SidebarThreadGroupHeader(props: {
  readonly group: SidebarThreadGroup;
  readonly memberCount: number;
  readonly isGenerating: boolean;
  readonly isDissolving?: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onRename: (title: string) => void;
  readonly onRegenerate: () => void;
  readonly onRemove: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(props.group.title);
  useEffect(() => setTitle(props.group.title), [props.group.title]);
  const [dragging, setDragging] = useState(false);
  useDndMonitor({
    onDragStart: () => setDragging(true),
    onDragEnd: () => setDragging(false),
    onDragCancel: () => setDragging(false),
  });

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
  const expanded = !props.group.collapsed;

  return (
    <div
      data-testid={`sidebar-thread-group-${props.group.id}`}
      className={cn(
        "group/thread-group relative h-8 transition-opacity duration-150 ease-out",
        // Keeps its height: the sortable preview measured it at pickup.
        props.isDissolving && "pointer-events-none opacity-30",
      )}
    >
      {isEditing ? (
        <div className="flex h-full items-center px-1">
          <SidebarRenameInput
            ariaLabel="Thread group title"
            value={title}
            onValueChange={setTitle}
            onCommit={commitRename}
            onCancel={cancelRename}
            className="h-6 text-xs"
          />
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={expanded}
          aria-busy={props.isGenerating || undefined}
          onClick={() => props.onCollapsedChange(expanded)}
          onDoubleClick={() => setIsEditing(true)}
          className={cn(
            "flex h-full w-full cursor-pointer items-center gap-2 px-1.5 text-left text-xs font-medium text-sidebar-muted-foreground/60",
            dragging && "text-sidebar-foreground/80",
          )}
        >
          <span className="flex min-w-0 shrink gap-1">
            <span className="truncate">{props.group.title}</span>
            <span className="shrink-0">({props.memberCount})</span>
          </span>
          {/* Zero basis: the rule fills only what the title leaves, and goes first. */}
          <span
            aria-hidden
            className={cn(
              "h-px min-w-0 flex-1 bg-sidebar-border/60",
              dragging && "bg-sidebar-foreground/25",
            )}
          />
          {/* Room for the hover menu, so it never covers the label. */}
          <span aria-hidden className="w-5 shrink-0" />
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
          />
        </button>
      )}
      {isEditing ? null : (
        <div className="absolute inset-y-0 right-6 flex items-center opacity-0 transition-opacity group-hover/thread-group:opacity-100 group-focus-within/thread-group:opacity-100 has-[[data-popup-open]]:opacity-100">
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost-muted" size="icon-micro" aria-label="Thread group actions">
                  <MoreHorizontalIcon />
                </Button>
              }
            />
            <MenuPopup side="bottom" align="end">
              <MenuItem onClick={() => setIsEditing(true)}>
                <SquarePenIcon />
                Rename
              </MenuItem>
              <MenuItem disabled={props.isGenerating} onClick={props.onRegenerate}>
                <RefreshCwIcon />
                Regenerate title
              </MenuItem>
              <MenuItem onClick={props.onRemove}>
                <UnlinkIcon />
                Dissolve group
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      )}
    </div>
  );
}

interface LayerBox {
  readonly top: number;
  readonly bottom: number;
}

// The sortable-tree example's indicator, drawn over the list rather than into
// it: a soft slot where the lifted row would land, indented to its projected
// depth, and one outline around the group it would join, or the thread a new
// group would start from. It reads the layout the sortable preview computed
// for this render, so it renders after the rows, as the list's last child.
export function SidebarThreadGroupDropLayerFork(props: {
  readonly items: readonly SidebarListItem[];
  readonly spans: readonly Pick<SidebarThreadGroupSpan, "groupKey" | "visibleKeys">[];
  readonly projection: SidebarThreadGroupProjection | null;
}) {
  const { active, droppableContainers } = useDndContext();
  const { projection } = props;
  const layout = sidebarProjectedLayoutFork(props.items);
  if (
    active === null ||
    projection === null ||
    projection.refused ||
    layout === null ||
    String(active.id) !== projection.activeId
  )
    return null;
  const box = (id: string): LayerBox | null => {
    const node = droppableContainers.get(id)?.node.current;
    const offset = layout.offsets.get(id);
    const height = layout.heights.get(id);
    if (!node || offset === undefined || height === undefined) return null;
    const top = node.offsetTop + offset;
    return { top, bottom: top + height };
  };
  const slot = box(projection.activeId);
  if (slot === null) return null;
  const parent = projection.parent;
  let outline: LayerBox | null = null;
  if (parent?.kind === "thread") outline = box(parent.key);
  if (parent?.kind === "group") {
    const span = props.spans.find((candidate) => candidate.groupKey === parent.groupKey);
    const header = sidebarMarkerId(sidebarThreadGroupHeaderMarker(parent.groupKey));
    const boxes = [header, ...(span?.visibleKeys ?? [])]
      .filter((id) => id !== projection.activeId)
      .flatMap((id) => box(id) ?? []);
    boxes.push(slot);
    outline = {
      top: Math.min(...boxes.map((entry) => entry.top)),
      bottom: Math.max(...boxes.map((entry) => entry.bottom)),
    };
  }
  const placed =
    "absolute right-0 transition-[top,left,height] duration-200 ease-out motion-reduce:transition-none";
  // Out of flow, so the list's gap never counts it as a row.
  return (
    <li aria-hidden className="pointer-events-none absolute inset-0 list-none">
      {outline === null ? null : (
        <div
          className={cn(placed, "left-0 rounded-lg bg-primary/8 ring-1 ring-primary")}
          style={{ top: outline.top, height: outline.bottom - outline.top }}
        />
      )}
      <div
        data-testid="sidebar-thread-group-drop-slot"
        data-depth={projection.depth}
        className={cn(placed, "rounded-md bg-primary/8")}
        // The row's py-0.5 stays outside the slot, as it does around a card.
        style={{
          top: slot.top + 2,
          left: projection.depth * SIDEBAR_THREAD_GROUP_INDENT,
          height: slot.bottom - slot.top - 4,
        }}
      />
    </li>
  );
}
