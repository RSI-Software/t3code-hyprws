import { arrayMove } from "@dnd-kit/sortable";

import type { SidebarThreadGroup, SidebarThreadGroupMembershipTarget } from "../uiStateStore";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  type SidebarListItem,
  type SidebarSection,
} from "./Sidebar.logic";
import {
  parseSidebarThreadGroupMarker,
  type SidebarThreadGroupSpan,
} from "./SidebarThreadGroup.markers";

// Group membership follows dnd-kit's sortable-tree example with a maximum
// depth of 1. The sidebar list is the flattened tree: a group header and every
// plain active thread sit at depth 0, a group's members at depth 1. While a row
// is lifted, the horizontal pointer offset picks its depth at the slot it would
// land in, bounded by its neighbours: the row above decides whether nesting is
// possible, the row below whether it is required. Depth 1 nests under the
// nearest depth-0 row above, which joins that group or, for a plain thread,
// creates one; a member projected to depth 0 leaves its group there.

/** How far a member card sits right of a plain one: the rail's margin, border,
    and padding. One step of this width changes the projected depth. */
export const SIDEBAR_THREAD_GROUP_INDENT = 15;

type GroupParent = {
  readonly kind: "group";
  readonly groupKey: string;
  readonly projectKey: string;
  readonly group: SidebarThreadGroup;
};
type ThreadParent = { readonly kind: "thread"; readonly key: string; readonly projectKey: string };
export type SidebarThreadGroupParent = GroupParent | ThreadParent;

interface SidebarThreadGroupTreeNode {
  readonly depth: 0 | 1;
  /** A collapsed group's anchor: it holds the group's slot in the drop order
      but never renders, so it is nobody's neighbour. */
  readonly hidden: boolean;
  /** What a row nested right below this one joins: a member's group, a
      header's group, or a plain active thread; null where nothing may nest. */
  readonly parent: SidebarThreadGroupParent | null;
  readonly thread: {
    readonly section: SidebarSection;
    readonly projectKey: string | null;
  } | null;
}

export interface SidebarThreadGroupTree {
  readonly items: readonly SidebarListItem[];
  readonly nodes: ReadonlyMap<string, SidebarThreadGroupTreeNode>;
  readonly indices: ReadonlyMap<string, number>;
}

/** The list as a depth-annotated tree, keyed by sortable id. */
export function sidebarThreadGroupTreeFork(input: {
  readonly items: readonly SidebarListItem[];
  readonly spans: readonly Pick<
    SidebarThreadGroupSpan,
    "groupKey" | "projectKey" | "group" | "visibleKeys"
  >[];
  readonly projectKeyOf: (threadKey: string) => string | null;
}): SidebarThreadGroupTree {
  const groups = new Map<string, GroupParent>();
  const memberOf = new Map<string, GroupParent>();
  const hidden = new Set<string>();
  for (const span of input.spans) {
    const parent: GroupParent = {
      kind: "group",
      groupKey: span.groupKey,
      projectKey: span.projectKey,
      group: span.group,
    };
    groups.set(span.groupKey, parent);
    for (const key of span.visibleKeys) memberOf.set(key, parent);
    if (span.group.collapsed && span.visibleKeys[0] !== undefined) hidden.add(span.visibleKeys[0]);
  }
  const nodes = new Map<string, SidebarThreadGroupTreeNode>();
  for (const item of input.items) {
    const id = sidebarListItemId(item);
    if (item.kind === "marker") {
      const edge = parseSidebarThreadGroupMarker(item.marker);
      const parent = edge === null ? null : (groups.get(edge.groupKey) ?? null);
      nodes.set(id, { depth: 0, hidden: false, parent, thread: null });
      continue;
    }
    const projectKey = input.projectKeyOf(item.key);
    const thread = { section: item.section, projectKey };
    const member = item.section === "active" ? memberOf.get(item.key) : undefined;
    if (member !== undefined) {
      nodes.set(id, { depth: 1, hidden: hidden.has(item.key), parent: member, thread });
      continue;
    }
    const parent =
      item.section === "active" && projectKey !== null
        ? ({ kind: "thread", key: item.key, projectKey } as const)
        : null;
    nodes.set(id, { depth: 0, hidden: false, parent, thread });
  }
  return {
    items: input.items,
    nodes,
    indices: new Map(input.items.map((item, index) => [sidebarListItemId(item), index])),
  };
}

interface SidebarThreadGroupSlot {
  readonly section: SidebarSection;
  readonly minDepth: number;
  readonly maxDepth: number;
  readonly parent: SidebarThreadGroupParent | null;
}

/** The depths the lifted row may take where dnd-kit's arrayMove puts it. */
function slotFor(
  tree: SidebarThreadGroupTree,
  activeId: string,
  overId: string,
): SidebarThreadGroupSlot | null {
  const activeIndex = tree.indices.get(activeId);
  const overIndex = tree.indices.get(overId);
  const active = tree.nodes.get(activeId);
  if (activeIndex === undefined || overIndex === undefined || active?.thread == null) return null;
  const section = resolveSidebarDropTarget(tree.items, activeId, overId)?.section;
  if (section === undefined) return null;
  const moved = arrayMove([...tree.items], activeIndex, overIndex);
  const neighbour = (from: number, step: 1 | -1) => {
    for (let index = from + step; index >= 0 && index < moved.length; index += step) {
      const node = tree.nodes.get(sidebarListItemId(moved[index]!));
      if (node !== undefined && !node.hidden) return node;
    }
    return undefined;
  };
  const parent = neighbour(overIndex, -1)?.parent ?? null;
  // A pinned thread never enters a group: pinning and grouping are separate
  // shelves, and the Active divider above the first slot offers no parent.
  const canNest =
    parent !== null &&
    active.thread.section !== "pinned" &&
    active.thread.projectKey === parent.projectKey;
  return {
    section,
    minDepth: neighbour(overIndex, 1)?.depth ?? 0,
    maxDepth: canNest ? 1 : 0,
    parent: canNest ? parent : null,
  };
}

export interface SidebarThreadGroupProjection {
  readonly activeId: string;
  readonly overId: string;
  /** No depth fits: the slot sits inside a group this row cannot join. */
  readonly refused: boolean;
  readonly depth: 0 | 1;
  /** What depth 1 nests under; null at depth 0. */
  readonly parent: SidebarThreadGroupParent | null;
}

/** The example's getProjection: the row's own depth plus whole indent steps of
    horizontal offset, clamped to what the neighbours at the slot allow. */
export function projectSidebarThreadGroupDepthFork(
  tree: SidebarThreadGroupTree,
  activeId: string,
  overId: string,
  steps: number,
): SidebarThreadGroupProjection | null {
  const slot = slotFor(tree, activeId, overId);
  const active = tree.nodes.get(activeId);
  if (slot === null || active === undefined) return null;
  if (slot.minDepth > slot.maxDepth)
    return { activeId, overId, refused: true, depth: 0, parent: null };
  const depth = Math.min(slot.maxDepth, Math.max(slot.minDepth, active.depth + steps)) as 0 | 1;
  return { activeId, overId, refused: false, depth, parent: depth === 1 ? slot.parent : null };
}

/** Whether `overId` can take the lifted row at some depth: false when none
    fits, true when a membership change is possible there, and undefined when
    only the upstream lifecycle drop decides. Independent of the pointer's
    horizontal offset, so collision detection can cache it per target. */
export function isSidebarThreadGroupSlotValidFork(
  tree: SidebarThreadGroupTree,
  activeId: string,
  overId: string,
): boolean | undefined {
  const slot = slotFor(tree, activeId, overId);
  if (slot === null) return undefined;
  if (slot.minDepth > slot.maxDepth) return false;
  const member = tree.nodes.get(activeId)?.depth === 1;
  return slot.section === "active" && (member || slot.maxDepth === 1) ? true : undefined;
}

export interface SidebarThreadGroupDrop {
  readonly projectKey: string;
  /** The rows the write moves; a new group lists its first member, then the lifted row. */
  readonly threadIds: readonly string[];
  readonly target: SidebarThreadGroupMembershipTarget;
}

/** The membership write a release performs; null when it keeps membership,
    e.g. a reorder inside the row's own group or among plain threads. */
export function resolveSidebarThreadGroupDropFork(
  tree: SidebarThreadGroupTree,
  projection: SidebarThreadGroupProjection,
  newGroup: () => Pick<SidebarThreadGroup, "id" | "title">,
): SidebarThreadGroupDrop | null {
  if (projection.refused) return null;
  const active = tree.nodes.get(projection.activeId);
  const own = active?.depth === 1 && active.parent?.kind === "group" ? active.parent : null;
  const threadIds = [projection.activeId];
  const parent = projection.parent;
  if (parent === null)
    return own === null
      ? null
      : { projectKey: own.projectKey, threadIds, target: { kind: "none" } };
  if (parent.kind === "thread")
    return {
      projectKey: parent.projectKey,
      threadIds: [parent.key, projection.activeId],
      target: { kind: "new", group: newGroup() },
    };
  if (parent.groupKey === own?.groupKey) return null;
  return {
    projectKey: parent.projectKey,
    threadIds,
    target: { kind: "existing", groupId: parent.group.id },
  };
}

/** The lifted row's own group when the projected drop would leave it with one
    member, so its header and rail fade with the drag instead of after it. */
export function sidebarThreadGroupDissolvingFork(
  tree: SidebarThreadGroupTree,
  projection: SidebarThreadGroupProjection | null,
): string | null {
  if (projection === null) return null;
  const active = tree.nodes.get(projection.activeId);
  if (active?.depth !== 1 || active.parent?.kind !== "group") return null;
  const own = active.parent;
  if (own.group.threadIds.length !== 2) return null;
  const drop = resolveSidebarThreadGroupDropFork(tree, projection, () => ({ id: "", title: "" }));
  return drop === null ? null : own.groupKey;
}
