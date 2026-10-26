import { useDndContext, useDndMonitor } from "@dnd-kit/core";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  ChevronDownIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SquarePenIcon,
  UnlinkIcon,
} from "lucide-react";
import { useState } from "react";

import type { SidebarThreadGroup } from "../state/threadGroups";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarThreadStatus,
} from "./Sidebar.logic";
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

// A parentless group mirrors upstream's shelf section header (label, count, hairline,
// chevron). A group with a parent wears its title as a tab on the parent card, whose surface
// hook pulls up 1px to close the gap under the tab. Either renders inside the group's sortable
// header marker so it moves with the rows during a drag.
export function SidebarThreadGroupHeader(props: {
  readonly group: SidebarThreadGroup;
  /** False where this client cannot edit the group: actions hide, collapse still works. */
  readonly canEdit: boolean;
  readonly memberCount: number;
  /** The parent's children, in list order; null for a parentless group. */
  readonly childThreads: readonly EnvironmentThreadShell[] | null;
  readonly isGenerating: boolean;
  readonly isDissolving?: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onRename: (title: string) => void;
  readonly onRegenerate: () => void;
  readonly onRemove: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(props.group.title);
  const [syncedTitle, setSyncedTitle] = useState(props.group.title);
  if (syncedTitle !== props.group.title) {
    setSyncedTitle(props.group.title);
    setTitle(props.group.title);
  }
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
  const children = props.childThreads;
  const statusDots = useChildStatusDots(expanded ? null : children);
  const toggle = {
    "aria-busy": props.isGenerating || undefined,
    onClick: () => props.onCollapsedChange(expanded),
    onDoubleClick: () => props.canEdit && setIsEditing(true),
  };

  return (
    <div
      data-testid={`sidebar-thread-group-${props.group.id}`}
      className={cn(
        "group/thread-group relative transition-opacity duration-150 ease-out",
        children ? "flex h-7 items-end gap-1" : "h-8",
        // Keeps its height: the sortable preview measured it at pickup.
        props.isDissolving && "pointer-events-none opacity-30",
      )}
    >
      {isEditing ? (
        <div className="flex h-full w-full items-center px-1">
          <SidebarRenameInput
            ariaLabel="Thread group title"
            value={title}
            onValueChange={setTitle}
            onCommit={commitRename}
            onCancel={cancelRename}
            className="h-6 text-xs"
          />
        </div>
      ) : children ? (
        // Disabled rather than unmounted while expanded, so a keyboard toggle keeps focus.
        <Tooltip disabled={expanded}>
          <TooltipTrigger
            render={
              <button
                type="button"
                {...toggle}
                aria-expanded={expanded}
                aria-label={`${props.group.title}, ${children.length} child ${children.length === 1 ? "thread" : "threads"}`}
                className={cn(
                  "flex h-full min-w-0 max-w-[calc(100%-1.75rem)] cursor-pointer items-center gap-1.5 rounded-t-lg bg-sidebar-row-hover/60 px-2.5 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                  dragging ? "text-sidebar-foreground/80" : "text-sidebar-muted-foreground",
                )}
              />
            }
          >
            <span className="truncate">{props.group.title}</span>
            <span className="shrink-0 tabular-nums opacity-70">{children.length}</span>
            {statusDots.length > 0 ? <SidebarThreadGroupStatusDots dots={statusDots} /> : null}
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", !expanded && "rotate-180")}
            />
          </TooltipTrigger>
          <TooltipPopup side="right">
            {statusDots.map((dot) => (
              <div key={dot.key} className="flex items-center gap-1.5">
                <span className={cn("size-2 shrink-0 rounded-full", dot.className)} />
                <span className="truncate">{dot.title}</span>
                <span className="text-muted-foreground">{dot.label}</span>
              </div>
            ))}
          </TooltipPopup>
        </Tooltip>
      ) : (
        <CollapsibleSectionHeader
          expanded={expanded}
          tone={dragging ? "emphasized" : "muted"}
          {...toggle}
          // Room for the hover menu, so it never covers the label.
          accessory={<span aria-hidden className="w-5 shrink-0" />}
        >
          <span className="flex min-w-0 gap-1">
            <span className="truncate">{props.group.title}</span>
            <span className="shrink-0">({props.memberCount})</span>
          </span>
        </CollapsibleSectionHeader>
      )}
      {isEditing || !props.canEdit ? null : (
        <div
          className={cn(
            "flex items-center opacity-0 transition-opacity group-hover/thread-group:opacity-100 group-focus-within/thread-group:opacity-100 has-[[data-popup-open]]:opacity-100",
            children ? "h-full" : "absolute inset-y-0 right-6",
          )}
        >
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

// Key order is urgency: a collapsed tab shows the first MAX_STATUS_DOTS, so a
// child that needs attention never hides behind the overflow count.
const STATUS_DOT: Record<SidebarThreadStatus | "done", { label: string; className: string }> = {
  approval: { label: "Approval", className: "bg-warning" },
  input: { label: "Input", className: "bg-indigo-500" },
  request: { label: "Request", className: "bg-guest" },
  failed: { label: "Failed", className: "bg-error" },
  limited: { label: "Limited", className: "bg-warning" },
  done: { label: "Done", className: "bg-success" },
  working: { label: "Working", className: "bg-info" },
  waiting: { label: "Waiting", className: "bg-muted-foreground/60" },
  ready: { label: "Read", className: "border border-muted-foreground/50" },
};
const URGENCY = Object.keys(STATUS_DOT);
const MAX_STATUS_DOTS = 6;

// A collapsed parent group keeps its parent row; its tab carries status dots
// for the hidden children in the rows' own colours, so a finished or blocked child
// still shows without opening the group. The tab's tooltip lists every child.
function useChildStatusDots(threads: readonly EnvironmentThreadShell[] | null) {
  const localVisits = useUiStateStore((state) => state.threadLastVisitedAtById);
  if (threads === null) return [];
  return threads
    .map((thread) => {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localVisits[key]);
      const status = resolveSidebarThreadStatus(thread);
      const kind =
        status === "ready" && hasUnseenCompletion({ ...thread, lastVisitedAt }) ? "done" : status;
      return { key, kind, title: thread.title, ...STATUS_DOT[kind] };
    })
    .toSorted((a, b) => URGENCY.indexOf(a.kind) - URGENCY.indexOf(b.kind));
}

function SidebarThreadGroupStatusDots(props: {
  readonly dots: ReturnType<typeof useChildStatusDots>;
}) {
  const overflow = props.dots.length - MAX_STATUS_DOTS;
  return (
    <span data-testid="sidebar-thread-group-dots" className="flex shrink-0 items-center gap-0.5">
      {props.dots.slice(0, MAX_STATUS_DOTS).map((dot) => (
        <span key={dot.key} className={cn("size-2 shrink-0 rounded-full", dot.className)} />
      ))}
      {overflow > 0 ? <span className="ms-0.5 tabular-nums">+{overflow}</span> : null}
    </span>
  );
}

interface LayerBox {
  readonly top: number;
  readonly bottom: number;
}

// The sortable-tree indicator, drawn over the list: a slot where the lifted row would land at
// its projected depth, and an outline around the group it would join or the thread a new group
// would start from. It reads the layout the sortable preview computed for this render, so it
// renders after the rows, as the list's last child.
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
