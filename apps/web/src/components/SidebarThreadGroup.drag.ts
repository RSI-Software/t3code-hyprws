import type { DragEndEvent, DragMoveEvent, DragOverEvent } from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";
import type { SidebarThreadGroup, SidebarThreadGroupMembershipTarget } from "../uiStateStore";
import type { SidebarDropTarget, SidebarListItem } from "./Sidebar.logic";
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
  readonly projectKeyOf: (thread: T) => string;
  readonly setMembership: (
    projectKey: string,
    order: readonly string[],
    threadIds: readonly string[],
    target: SidebarThreadGroupMembershipTarget,
  ) => void;
  readonly requestTitle: (request: {
    readonly projectKey: string;
    readonly groupId: string;
    readonly members: readonly T[];
    readonly expectedGroup: Pick<SidebarThreadGroup, "title" | "threadIds">;
  }) => unknown;
}) {
  const { items, spans, threadByKey, projectKeyOf, setMembership, requestTitle } = input;
  const tree = useMemo(
    () =>
      sidebarThreadGroupTreeFork({
        items,
        spans,
        projectKeyOf: (key) => {
          const thread = threadByKey.get(key);
          return thread === undefined ? null : projectKeyOf(thread);
        },
      }),
    [items, projectKeyOf, spans, threadByKey],
  );
  const [drag, setDrag] = useState<GroupDrag | null>(null);
  const dragRef = useRef<GroupDrag | null>(null);
  const updateDrag = useCallback((next: (current: GroupDrag | null) => GroupDrag | null) => {
    const value = next(dragRef.current);
    if (value === dragRef.current) return;
    dragRef.current = value;
    setDrag(value);
  }, []);

  const activeId = drag?.activeId ?? null;
  const originX = drag?.originX ?? null;
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

  const projection = useMemo(
    () =>
      drag?.overId == null
        ? null
        : projectSidebarThreadGroupDepthFork(tree, drag.activeId, drag.overId, drag.steps),
    [drag, tree],
  );

  // Both events carry the current target; the first one of a drag also
  // starts it, taking the pickup point from the event that activated it.
  const over = useCallback(
    (event: DragMoveEvent | DragOverEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over === null ? null : String(event.over.id);
      updateDrag((current) => {
        if (current?.activeId !== activeId) {
          const pointer =
            event.activatorEvent instanceof PointerEvent ? event.activatorEvent : null;
          return { activeId, overId, originX: pointer?.clientX ?? null, steps: 0 };
        }
        return current.overId === overId ? current : { ...current, overId };
      });
    },
    [updateDrag],
  );
  const reset = useCallback(() => updateDrag(() => null), [updateDrag]);
  const isValidTarget = useCallback(
    (activeKey: string, overId: string) =>
      isSidebarThreadGroupSlotValidFork(tree, activeKey, overId),
    [tree],
  );
  const release = useCallback(
    (event: DragEndEvent, target: SidebarDropTarget | null) => {
      const current = dragRef.current;
      updateDrag(() => null);
      if (current === null || event.over === null || target === null) return;
      const released = projectSidebarThreadGroupDepthFork(
        tree,
        String(event.active.id),
        String(event.over.id),
        current.steps,
      );
      if (released === null) return;
      const drop = resolveSidebarThreadGroupDropFork(tree, released, () => ({
        id: randomUUID(),
        title: "New group",
      }));
      if (drop === null) return;
      setMembership(drop.projectKey, target.activeOrder, drop.threadIds, drop.target);
      if (drop.target.kind !== "new") return;
      const members = drop.threadIds.flatMap((key) => threadByKey.get(key) ?? []);
      void requestTitle({
        projectKey: drop.projectKey,
        groupId: drop.target.group.id,
        members,
        expectedGroup: { title: drop.target.group.title, threadIds: [...drop.threadIds] },
      });
    },
    [requestTitle, setMembership, threadByKey, tree, updateDrag],
  );

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
