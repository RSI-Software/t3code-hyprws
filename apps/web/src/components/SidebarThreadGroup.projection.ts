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
// A group's parent sits flush at depth 0, still a member. Right under a
// group's header, depth 0 makes the lifted row that group's parent.

/** How far a member card sits right of a plain one: the rail's margin, border,
    and padding. One step of this width changes the projected depth. */
export const SIDEBAR_THREAD_GROUP_INDENT = 15;

type GroupParent = {
  readonly kind: "group";
  readonly groupKey: string;
  readonly group: SidebarThreadGroup;
};
type ThreadParent = { readonly kind: "thread"; readonly key: string };
export type SidebarThreadGroupParent = GroupParent | ThreadParent;

interface SidebarThreadGroupTreeNode {
  readonly depth: 0 | 1;
  /** The group this row belongs to; a parent row is a member at depth 0. */
  readonly group: GroupParent | null;
  /** A collapsed group's anchor: it holds the group's slot in the drop order
      but never renders, so it is nobody's neighbour. */
  readonly hidden: boolean;
  /** What a row nested right below this one joins: a member's group, a
      header's group, or a plain active thread; null where nothing may nest. */
  readonly parent: SidebarThreadGroupParent | null;
  readonly thread: { readonly section: SidebarSection } | null;
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
    "groupKey" | "group" | "visibleKeys" | "parentKey"
  >[];
}): SidebarThreadGroupTree {
  const groups = new Map<string, GroupParent>();
  const memberOf = new Map<string, GroupParent>();
  const hidden = new Set<string>();
  const leaders = new Set<string>();
  for (const span of input.spans) {
    const parent: GroupParent = { kind: "group", groupKey: span.groupKey, group: span.group };
    groups.set(span.groupKey, parent);
    for (const key of span.visibleKeys) memberOf.set(key, parent);
    if (span.parentKey !== null) leaders.add(span.parentKey);
    // A collapsed group's parent stays in view and folds its children.
    else if (span.group.collapsed && span.visibleKeys[0] !== undefined)
      hidden.add(span.visibleKeys[0]);
  }
  const nodes = new Map<string, SidebarThreadGroupTreeNode>();
  for (const item of input.items) {
    const id = sidebarListItemId(item);
    if (item.kind === "marker") {
      const edge = parseSidebarThreadGroupMarker(item.marker);
      const parent = edge === null ? null : (groups.get(edge.groupKey) ?? null);
      nodes.set(id, { depth: 0, group: null, hidden: false, parent, thread: null });
      continue;
    }
    const thread = { section: item.section };
    const member = item.section === "active" ? memberOf.get(item.key) : undefined;
    if (member !== undefined) {
      const depth = leaders.has(item.key) ? 0 : 1;
      nodes.set(id, { depth, group: member, hidden: hidden.has(item.key), parent: member, thread });
      continue;
    }
    const parent = item.section === "active" ? ({ kind: "thread", key: item.key } as const) : null;
    nodes.set(id, { depth: 0, group: null, hidden: false, parent, thread });
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
  /** The group whose header sits right above a slot inside its span. */
  readonly headerGroup: GroupParent | null;
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
  const above = neighbour(overIndex, -1);
  const below = neighbour(overIndex, 1);
  const parent = above?.parent ?? null;
  // A pinned thread never enters a group: pinning and grouping are separate
  // shelves, and the Active divider above the first slot offers no parent.
  const canNest = parent !== null && active.thread.section !== "pinned";
  // The span continues below the slot, or the lifted row is the collapsed
  // group's parent, its only row in view.
  const inSpan = (group: GroupParent) => below?.group === group || active.group === group;
  const headerGroup =
    canNest && above?.thread === null && parent.kind === "group" && inSpan(parent) ? parent : null;
  return {
    section,
    minDepth: headerGroup === null ? (below?.depth ?? 0) : 0,
    maxDepth: canNest ? 1 : 0,
    parent: canNest ? parent : null,
    headerGroup,
  };
}

export interface SidebarThreadGroupProjection {
  readonly activeId: string;
  readonly overId: string;
  /** No depth fits: the slot sits inside a group this row cannot join. */
  readonly refused: boolean;
  readonly depth: 0 | 1;
  /** What depth 1 nests under, or the group a new parent leads; else null. */
  readonly parent: SidebarThreadGroupParent | null;
  /** Depth 0 right under a group's header: the row becomes its parent. */
  readonly asParent: boolean;
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
    return { activeId, overId, refused: true, depth: 0, parent: null, asParent: false };
  const depth = Math.min(slot.maxDepth, Math.max(slot.minDepth, active.depth + steps)) as 0 | 1;
  const asParent = depth === 0 && slot.headerGroup !== null;
  const parent = depth === 1 ? slot.parent : slot.headerGroup;
  return { activeId, overId, refused: false, depth, parent, asParent };
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
  const member = tree.nodes.get(activeId)?.group != null;
  return slot.section === "active" && (member || slot.maxDepth === 1) ? true : undefined;
}

export interface SidebarThreadGroupDrop {
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
  const own = active?.group ?? null;
  const leads = own !== null && active?.depth === 0;
  const threadIds = [projection.activeId];
  const parent = projection.parent;
  if (parent === null) return own === null ? null : { threadIds, target: { kind: "none" } };
  if (parent.kind === "thread")
    return {
      threadIds: [parent.key, projection.activeId],
      target: { kind: "new", group: newGroup() },
    };
  const groupId = parent.group.id;
  if (projection.asParent)
    return leads && parent.groupKey === own.groupKey
      ? null
      : { threadIds, target: { kind: "existing", groupId, asParent: true } };
  // Rejoining its own group as a child is how a parent steps down.
  if (parent.groupKey === own?.groupKey && !leads) return null;
  return { threadIds, target: { kind: "existing", groupId } };
}

/** The lifted row's own group when the projected drop would leave it with one
    member, so its header and rail fade with the drag instead of after it. */
export function sidebarThreadGroupDissolvingFork(
  tree: SidebarThreadGroupTree,
  projection: SidebarThreadGroupProjection | null,
): string | null {
  if (projection === null) return null;
  const own = tree.nodes.get(projection.activeId)?.group;
  if (own == null || own.group.threadIds.length !== 2) return null;
  const drop = resolveSidebarThreadGroupDropFork(tree, projection, () => ({ id: "", title: "" }));
  if (drop === null) return null;
  const stays = drop.target.kind === "existing" && drop.target.groupId === own.group.id;
  return stays ? null : own.groupKey;
}
