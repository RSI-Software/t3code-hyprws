import type { DragEndEvent, DragMoveEvent, DragOverEvent } from "@dnd-kit/core";
import { useEffect, useRef, useState } from "react";

import {
  newThreadGroupKeyFork,
  type SidebarThreadGroup,
  type SidebarThreadGroupMembershipTarget,
} from "../state/threadGroups";
import { resolveSidebarDropTarget, type SidebarListItem } from "./Sidebar.logic";
type SidebarDropTarget = NonNullable<ReturnType<typeof resolveSidebarDropTarget>>;
import type { SidebarThreadGroupSpan } from "./SidebarThreadGroup.markers";
import {
  isSidebarThreadGroupSlotValidFork,
  projectSidebarThreadGroupDepthFork,
  resolveSidebarThreadGroupDropFork,
  SIDEBAR_THREAD_GROUP_INDENT,
  sidebarThreadGroupDissolvingFork,
  sidebarThreadGroupTreeFork,
} from "./SidebarThreadGroup.projection";

interface GroupDrag {
  readonly activeId: string;
  readonly overId: string | null;
  /** The pointer's x at pickup; null for a keyboard drag, which never nests. */
  readonly originX: number | null;
  /** Whole indent steps the pointer has moved sideways, clamped to ±1. */
  readonly steps: number;
}

/** Everything the sidebar's drag lifecycle needs to project and write group
    membership. The sortable modifiers pin the lifted row to the vertical axis,
    so dnd-kit's own delta carries no horizontal offset: the pointer is read
    directly while a drag is live. */
export function useSidebarThreadGroupDragFork<T>(input: {
  readonly items: readonly SidebarListItem[];
  readonly spans: readonly SidebarThreadGroupSpan<T>[];
  readonly threadByKey: ReadonlyMap<string, T>;
  readonly setMembership: (
    threadIds: readonly string[],
    target: SidebarThreadGroupMembershipTarget,
  ) => boolean;
  /** False when these threads, or the group they would join, cannot be grouped here. */
  readonly canGroup: (threadKeys: readonly string[], groupKey: string | null) => boolean;
  readonly requestTitle: (request: {
    readonly groupId: string;
    readonly members: readonly T[];
    readonly expectedGroup: Pick<SidebarThreadGroup, "title" | "threadIds">;
  }) => unknown;
}) {
  const { items, spans, threadByKey, setMembership, canGroup, requestTitle } = input;
  const tree = sidebarThreadGroupTreeFork({ items, spans });
  const [drag, setDrag] = useState<GroupDrag | null>(null);
  const dragRef = useRef<GroupDrag | null>(null);
  const updateDrag = (next: (current: GroupDrag | null) => GroupDrag | null) => {
    const value = next(dragRef.current);
    if (value === dragRef.current) return;
    dragRef.current = value;
    setDrag(value);
  };

  const activeId = drag?.activeId ?? null;
  const originX = drag?.originX ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document `pointermove` DOM events while a group drag is active.
  useEffect(() => {
    if (activeId === null || originX === null) return;
    // Pointer-rate: write only when the pointer crosses into another step.
    const onMove = (event: PointerEvent) => {
      const offset = Math.round((event.clientX - originX) / SIDEBAR_THREAD_GROUP_INDENT);
      const steps = Math.max(-1, Math.min(1, offset));
      updateDrag((current) =>
        current?.activeId === activeId && current.steps !== steps ? { ...current, steps } : current,
      );
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => document.removeEventListener("pointermove", onMove);
  }, [activeId, originX, updateDrag]);

  const newGroup = (firstThreadKey: string) => ({
    id: newThreadGroupKeyFork(firstThreadKey),
    title: "New group",
  });
  /** Where a release would land, or null when the write it implies cannot apply. */
  const project = (activeId: string, overId: string, steps: number) => {
    const projected = projectSidebarThreadGroupDepthFork(tree, activeId, overId, steps);
    const drop =
      projected === null ? null : resolveSidebarThreadGroupDropFork(tree, projected, newGroup);
    if (drop === null) return { projected, drop };
    const groupKey = drop.target.kind === "existing" ? drop.target.groupId : null;
    return canGroup(drop.threadIds, groupKey)
      ? { projected, drop }
      : { projected: null, drop: null };
  };
  const projection =
    drag?.overId == null ? null : project(drag.activeId, drag.overId, drag.steps).projected;

  // Both events carry the current target; the first one of a drag also
  // starts it, taking the pickup point from the event that activated it.
  const over = (event: DragMoveEvent | DragOverEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over === null ? null : String(event.over.id);
    updateDrag((current) => {
      if (current?.activeId !== activeId) {
        const pointer = event.activatorEvent instanceof PointerEvent ? event.activatorEvent : null;
        return { activeId, overId, originX: pointer?.clientX ?? null, steps: 0 };
      }
      return current.overId === overId ? current : { ...current, overId };
    });
  };
  const reset = () => updateDrag(() => null);
  const isValidTarget = (activeKey: string, overId: string) =>
    isSidebarThreadGroupSlotValidFork(tree, activeKey, overId);
  const release = (event: DragEndEvent, target: SidebarDropTarget | null) => {
    const current = dragRef.current;
    updateDrag(() => null);
    if (current === null || event.over === null || target === null) return;
    const { drop } = project(String(event.active.id), String(event.over.id), current.steps);
    if (drop === null) return;
    if (!setMembership(drop.threadIds, drop.target) || drop.target.kind !== "new") return;
    const members = drop.threadIds.flatMap((key) => threadByKey.get(key) ?? []);
    void requestTitle({
      groupId: drop.target.group.id,
      members,
      expectedGroup: { title: drop.target.group.title, threadIds: [...drop.threadIds] },
    });
  };

  return {
    projection,
    dissolvingGroupKey: sidebarThreadGroupDissolvingFork(tree, projection),
    over,
    release,
    isValidTarget,
    /** Spread onto the DndContext: a cancelled drag writes nothing. */
    dndHandlers: { onDragMove: over, onDragCancel: reset },
    layerProps: { items, spans, projection },
  };
}
