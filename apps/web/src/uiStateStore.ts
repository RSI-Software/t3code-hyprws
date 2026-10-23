import { Debouncer } from "@tanstack/react-pacer";
import type { PullRequestMergeMethod } from "@t3tools/contracts";
import { create } from "zustand";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";
import * as forkWindowSidebarScope from "./windowSidebarScope.fork"; // fork-hook: multi-window/window-sidebar-scope-import

export const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
const THREAD_CHANGED_FILES_EXPANSION_VERSION = 2;
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v8",
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

export interface PersistedUiState {
  projectExpandedById?: Record<string, boolean>;
  projectOrder?: string[];
  threadOrderByProject?: Record<string, string[]>;
  threadGroups?: SidebarThreadGroup[]; // fork-hook: thread-ordering/group-state
  threadGroupsByProject?: Record<string, SidebarThreadGroup[]>;
  threadLastVisitedAtById?: Record<string, string>;
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  sidebarProjectScopeKey?: string | null;
  threadChangedFilesExpansionVersion?: number;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
  pullRequestMergeMethod?: string;
}

export interface SidebarThreadGroup {
  id: string;
  title: string;
  threadIds: string[];
  collapsed: boolean;
  /** A member shown first, with the rest indented under it. Visual only. */
  parentThreadId?: string;
} // fork-hook: thread-ordering/group-type

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
  sidebarProjectScopeKey: string | null;
}

export interface UiThreadState {
  threadOrderByProject: Record<string, string[]>;
  threadGroups: SidebarThreadGroup[]; // fork-hook: thread-ordering/group-state
  threadLastVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export interface UiPullRequestState {
  pullRequestMergeMethod: PullRequestMergeMethod;
}

export interface UiState
  extends UiProjectState, UiThreadState, UiEndpointState, UiPullRequestState {}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  sidebarProjectScopeKey: null,
  threadOrderByProject: {},
  threadGroups: [], // fork-hook: thread-ordering/group-state
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
  defaultAdvertisedEndpointKey: null,
  pullRequestMergeMethod: "merge",
};

const LEGACY_PROJECT_CWD_PREFERENCE_PREFIX = "legacy-project-cwd:";
const LEGACY_PROJECT_EXPANSION_DEFAULT_KEY = "legacy-project-expansion-default";
let legacyKeysCleanedUp = false;

export function legacyProjectCwdPreferenceKey(cwd: string): string {
  return `${LEGACY_PROJECT_CWD_PREFERENCE_PREFIX}${normalizeProjectPathForComparison(cwd)}`;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

function sanitizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => entry[0].length > 0 && typeof entry[1] === "boolean",
    ),
  );
}

function sanitizeOptionalKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sanitizeStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entries]) => {
      if (key.length === 0) return [];
      const sanitized = sanitizeStringArray(entries);
      return sanitized.length > 0 ? [[key, sanitized] as const] : [];
    }),
  );
}

function sanitizeThreadGroups(value: unknown): SidebarThreadGroup[] {
  if (!Array.isArray(value)) return [];
  const usedThreadIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  return value.flatMap((group): SidebarThreadGroup[] => {
    if (!group || typeof group !== "object") return [];
    const candidate = group as Partial<SidebarThreadGroup>;
    if (typeof candidate.id !== "string" || !candidate.id) return [];
    if (usedGroupIds.has(candidate.id)) return [];
    if (typeof candidate.title !== "string" || !candidate.title.trim()) return [];
    const threadIds = sanitizeStringArray(candidate.threadIds).filter((id) => {
      if (usedThreadIds.has(id)) return false;
      usedThreadIds.add(id);
      return true;
    });
    if (threadIds.length < 2) {
      for (const id of threadIds) usedThreadIds.delete(id);
      return [];
    }
    usedGroupIds.add(candidate.id);
    return [
      {
        id: candidate.id,
        title: candidate.title.trim(),
        threadIds,
        collapsed: candidate.collapsed === true,
        ...(typeof candidate.parentThreadId === "string" &&
        threadIds.includes(candidate.parentThreadId)
          ? { parentThreadId: candidate.parentThreadId }
          : {}),
      },
    ];
  });
} // fork-hook: thread-ordering/group-sanitize

function sanitizeTimestampRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].length > 0 &&
        Number.isFinite(Date.parse(entry[1])),
    ),
  );
}

function isPullRequestMergeMethod(value: unknown): value is PullRequestMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}

export function parsePersistedState(parsed: PersistedUiState): UiState {
  const projectExpandedById =
    parsed.projectExpandedById === undefined
      ? (() => {
          const migrated: Record<string, boolean> = {};
          const collapsedProjectCwds = sanitizeStringArray(parsed.collapsedProjectCwds);
          const expandedProjectCwds = sanitizeStringArray(parsed.expandedProjectCwds);
          for (const cwd of collapsedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = false;
          }
          for (const cwd of expandedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = true;
          }
          if (!Array.isArray(parsed.collapsedProjectCwds) && expandedProjectCwds.length > 0) {
            migrated[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] = false;
          }
          return migrated;
        })()
      : sanitizeBooleanRecord(parsed.projectExpandedById);
  const projectOrder =
    parsed.projectOrder === undefined
      ? sanitizeStringArray(parsed.projectOrderCwds).map(legacyProjectCwdPreferenceKey)
      : sanitizeStringArray(parsed.projectOrder);

  return {
    projectExpandedById,
    projectOrder,
    threadOrderByProject: sanitizeStringArrayRecord(parsed.threadOrderByProject),
    threadGroups: sanitizeThreadGroups(
      parsed.threadGroups ??
        (parsed.threadGroupsByProject && typeof parsed.threadGroupsByProject === "object"
          ? Object.values(parsed.threadGroupsByProject).flat()
          : undefined),
    ), // fork-hook: thread-ordering/group-parse
    threadLastVisitedAtById: sanitizeTimestampRecord(parsed.threadLastVisitedAtById),
    threadChangedFilesExpandedById:
      parsed.threadChangedFilesExpansionVersion === THREAD_CHANGED_FILES_EXPANSION_VERSION
        ? sanitizePersistedThreadChangedFilesExpanded(parsed.threadChangedFilesExpandedById)
        : {},
    defaultAdvertisedEndpointKey: sanitizeOptionalKey(parsed.defaultAdvertisedEndpointKey),
    sidebarProjectScopeKey: sanitizeOptionalKey(parsed.sidebarProjectScopeKey),
    pullRequestMergeMethod: isPullRequestMergeMethod(parsed.pullRequestMergeMethod)
      ? parsed.pullRequestMergeMethod
      : initialState.pullRequestMergeMethod,
  };
}

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        return parsePersistedState(JSON.parse(legacyRaw) as PersistedUiState);
      }
      return initialState;
    }
    return parsePersistedState(JSON.parse(raw) as PersistedUiState);
  } catch {
    return initialState;
  }
}

function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean") {
        nextTurns[turnId] = expanded;
      }
    }

    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }

  return nextState;
}

export function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const projectExpandedById = Object.fromEntries(
      Object.entries(state.projectExpandedById).filter(
        ([key]) => key !== LEGACY_PROJECT_EXPANSION_DEFAULT_KEY,
      ),
    );
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectExpandedById,
        projectOrder: state.projectOrder,
        // Manual order and groups are fork state: written only once the user has
        // actually reordered or grouped something, so a profile that never
        // touched them stays byte-identical to what upstream persists.
        ...(Object.keys(state.threadOrderByProject).length > 0
          ? { threadOrderByProject: state.threadOrderByProject }
          : {}),
        ...(state.threadGroups.length > 0 ? { threadGroups: state.threadGroups } : {}), // fork-hook: thread-ordering/group-persist
        threadLastVisitedAtById: state.threadLastVisitedAtById,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        sidebarProjectScopeKey: state.sidebarProjectScopeKey,
        threadChangedFilesExpansionVersion: THREAD_CHANGED_FILES_EXPANSION_VERSION,
        threadChangedFilesExpandedById: state.threadChangedFilesExpandedById,
        pullRequestMergeMethod: state.pullRequestMergeMethod,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {}
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

export function markThreadVisited(state: UiState, threadId: string, visitedAt: string): UiState {
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) {
    return state;
  }
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: visitedAt,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: string,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: string,
  turnId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  if (currentThreadState[turnId] === expanded) {
    return state;
  }

  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: {
        ...currentThreadState,
        [turnId]: expanded,
      },
    },
  };
}

function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

function setSidebarProjectScopeKey(state: UiState, projectKey: string | null): UiState {
  const nextKey = sanitizeOptionalKey(projectKey);
  if (state.sidebarProjectScopeKey === nextKey) {
    return state;
  }
  return {
    ...state,
    sidebarProjectScopeKey: nextKey,
  };
}

function setPullRequestMergeMethod(state: UiState, method: PullRequestMergeMethod): UiState {
  return state.pullRequestMergeMethod === method
    ? state
    : { ...state, pullRequestMergeMethod: method };
}

export function resolveProjectExpanded(
  projectExpandedById: Readonly<Record<string, boolean>>,
  preferenceKeys: readonly string[],
): boolean {
  for (const key of preferenceKeys) {
    const expanded = projectExpandedById[key];
    if (expanded !== undefined) {
      return expanded;
    }
  }
  return projectExpandedById[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] ?? true;
}

export function setProjectExpanded(
  state: UiState,
  projectIds: string | readonly string[],
  expanded: boolean,
): UiState {
  const ids = typeof projectIds === "string" ? [projectIds] : projectIds;
  const nextEntries = ids.filter((projectId) => state.projectExpandedById[projectId] !== expanded);
  if (nextEntries.length === 0) {
    return state;
  }
  const projectExpandedById = { ...state.projectExpandedById };
  for (const projectId of nextEntries) {
    projectExpandedById[projectId] = expanded;
  }
  return {
    ...state,
    projectExpandedById,
  };
}

export function reorderProjects(
  state: UiState,
  currentProjectOrder: readonly string[],
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = currentProjectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...currentProjectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

export function reorderProjectThreads(
  state: UiState,
  projectKey: string,
  currentThreadOrder: readonly string[],
  draggedThreadId: string,
  targetThreadId: string,
): UiState {
  if (!projectKey || draggedThreadId === targetThreadId) {
    return state;
  }
  const fromIndex = currentThreadOrder.indexOf(draggedThreadId);
  const toIndex = currentThreadOrder.indexOf(targetThreadId);
  if (fromIndex < 0 || toIndex < 0) {
    return state;
  }
  const threadOrder = [...currentThreadOrder];
  const [dragged] = threadOrder.splice(fromIndex, 1);
  if (dragged === undefined) {
    return state;
  }
  threadOrder.splice(toIndex, 0, dragged);
  return {
    ...state,
    threadOrderByProject: {
      ...state.threadOrderByProject,
      [projectKey]: threadOrder,
    },
  };
}

export type SidebarThreadDropMode = "reorder" | "group";

function orderedGroupThreadIds(threadIds: readonly string[], order: readonly string[]): string[] {
  const members = new Set(threadIds);
  const ordered = order.filter((id) => members.has(id));
  const orderedIds = new Set(ordered);
  const remaining = threadIds.filter((id) => {
    if (orderedIds.has(id)) return false;
    orderedIds.add(id);
    return true;
  });
  return [...ordered, ...remaining];
}

export type SidebarThreadGroupMembershipTarget =
  | {
      readonly kind: "existing";
      readonly groupId: string;
      /** The one joining thread becomes the group's parent. */
      readonly asParent?: boolean;
    } // fork-hook: thread-ordering/group-target
  | { readonly kind: "new"; readonly group: Pick<SidebarThreadGroup, "id" | "title"> }
  | { readonly kind: "none" };

function sameThreadGroup(left: SidebarThreadGroup, right: SidebarThreadGroup | undefined): boolean {
  return (
    right?.id === left.id &&
    right.title === left.title &&
    right.collapsed === left.collapsed &&
    right.parentThreadId === left.parentThreadId &&
    right.threadIds.length === left.threadIds.length &&
    right.threadIds.every((threadId, index) => left.threadIds[index] === threadId)
  );
} // fork-hook: thread-ordering/group-equal

export function setThreadGroupMembership(
  state: UiState,
  currentThreadOrder: readonly string[],
  threadIds: readonly string[],
  target: SidebarThreadGroupMembershipTarget,
): UiState {
  const orderedThreadIds = orderedGroupThreadIds([...new Set(threadIds)], currentThreadOrder);
  if (orderedThreadIds.length === 0 || (target.kind === "new" && orderedThreadIds.length < 2)) {
    return state;
  }

  const currentGroups = state.threadGroups;
  if (target.kind === "existing" && !currentGroups.some((group) => group.id === target.groupId)) {
    return state;
  }
  const movingIds = new Set(orderedThreadIds);
  let groups = currentGroups.map((group): SidebarThreadGroup => {
    const { parentThreadId, ...rest } = group;
    return {
      ...rest,
      threadIds: group.threadIds.filter((threadId) => !movingIds.has(threadId)),
      // A parent that leaves its group stops leading it.
      ...(parentThreadId === undefined || movingIds.has(parentThreadId) ? {} : { parentThreadId }),
    };
  });

  if (target.kind === "existing") {
    groups = groups.map((group) =>
      group.id === target.groupId
        ? {
            ...group,
            collapsed: false,
            threadIds: orderedGroupThreadIds(
              [...group.threadIds, ...orderedThreadIds],
              currentThreadOrder,
            ),
            ...(target.asParent ? { parentThreadId: orderedThreadIds[0]! } : {}),
          }
        : group,
    );
  } else if (target.kind === "new") {
    groups.push({
      ...target.group,
      threadIds: orderedThreadIds,
      collapsed: false,
    });
  }

  groups = groups.filter((group) => group.threadIds.length >= 2);
  if (
    groups.length === currentGroups.length &&
    groups.every((group, index) => sameThreadGroup(group, currentGroups[index]))
  ) {
    return state;
  }

  return { ...state, threadGroups: groups };
} // fork-hook: thread-ordering/group-membership

function updateThreadGroup(
  state: UiState,
  groupId: string,
  update: (group: SidebarThreadGroup) => SidebarThreadGroup,
): UiState {
  let changed = false;
  const threadGroups = state.threadGroups.map((group) => {
    if (group.id !== groupId) return group;
    const next = update(group);
    if (sameThreadGroup(next, group)) return group;
    changed = true;
    return next;
  });
  return changed ? { ...state, threadGroups } : state;
} // fork-hook: thread-ordering/group-update

export function renameThreadGroup(state: UiState, groupId: string, title: string): UiState {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return state;
  return updateThreadGroup(state, groupId, (group) => ({ ...group, title: trimmedTitle }));
} // fork-hook: thread-ordering/group-rename

export function renameThreadGroupIfCurrent(
  state: UiState,
  groupId: string,
  expected: Pick<SidebarThreadGroup, "title" | "threadIds">,
  title: string,
): UiState {
  const group = state.threadGroups.find((candidate) => candidate.id === groupId);
  if (
    !group ||
    group.title !== expected.title ||
    group.threadIds.length !== expected.threadIds.length ||
    expected.threadIds.some((threadId) => !group.threadIds.includes(threadId))
  ) {
    return state;
  }
  return renameThreadGroup(state, groupId, title);
} // fork-hook: thread-ordering/group-rename-if-current

function setThreadGroupCollapsed(state: UiState, groupId: string, collapsed: boolean): UiState {
  return updateThreadGroup(state, groupId, (group) => ({ ...group, collapsed }));
} // fork-hook: thread-ordering/group-collapse

export function setThreadGroupParent(
  state: UiState,
  groupId: string,
  parentThreadId: string | null,
): UiState {
  return updateThreadGroup(state, groupId, (group) => {
    const { parentThreadId: _previous, ...rest } = group;
    return parentThreadId !== null && group.threadIds.includes(parentThreadId)
      ? { ...rest, parentThreadId }
      : rest;
  });
} // fork-hook: thread-ordering/group-parent

function removeThreadGroup(state: UiState, groupId: string): UiState {
  const threadGroups = state.threadGroups.filter((group) => group.id !== groupId);
  return threadGroups.length === state.threadGroups.length ? state : { ...state, threadGroups };
} // fork-hook: thread-ordering/group-remove

interface UiStateStore extends UiState {
  markThreadVisited: (threadId: string, visitedAt: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  setSidebarProjectScopeKey: (projectKey: string | null) => void;
  setPullRequestMergeMethod: (method: PullRequestMergeMethod) => void;
  setProjectExpanded: (projectIds: string | readonly string[], expanded: boolean) => void;
  reorderProjects: (
    currentProjectOrder: readonly string[],
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
  reorderProjectThreads: (
    projectKey: string,
    currentThreadOrder: readonly string[],
    draggedThreadId: string,
    targetThreadId: string,
  ) => void;
  setThreadGroupMembership: (
    currentThreadOrder: readonly string[],
    threadIds: readonly string[],
    target: SidebarThreadGroupMembershipTarget,
  ) => void; // fork-hook: thread-ordering/group-actions
  renameThreadGroup: (groupId: string, title: string) => void; // fork-hook: thread-ordering/group-actions
  renameThreadGroupIfCurrent: (
    groupId: string,
    expected: Pick<SidebarThreadGroup, "title" | "threadIds">,
    title: string,
  ) => void; // fork-hook: thread-ordering/group-actions
  setThreadGroupCollapsed: (groupId: string, collapsed: boolean) => void; // fork-hook: thread-ordering/group-actions
  setThreadGroupParent: (groupId: string, parentThreadId: string | null) => void; // fork-hook: thread-ordering/group-actions
  removeThreadGroup: (groupId: string) => void; // fork-hook: thread-ordering/group-actions
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded) =>
    set((state) => setThreadChangedFilesExpanded(state, threadId, turnId, expanded)),
  setDefaultAdvertisedEndpointKey: (key) =>
    set((state) => setDefaultAdvertisedEndpointKey(state, key)),
  setSidebarProjectScopeKey: (projectKey) =>
    set((state) => setSidebarProjectScopeKey(state, projectKey)),
  setPullRequestMergeMethod: (method) => set((state) => setPullRequestMergeMethod(state, method)),
  setProjectExpanded: (projectIds, expanded) =>
    set((state) => setProjectExpanded(state, projectIds, expanded)),
  reorderProjects: (currentProjectOrder, draggedProjectIds, targetProjectIds) =>
    set((state) =>
      reorderProjects(state, currentProjectOrder, draggedProjectIds, targetProjectIds),
    ),
  reorderProjectThreads: (projectKey, currentThreadOrder, draggedThreadId, targetThreadId) =>
    set((state) =>
      reorderProjectThreads(state, projectKey, currentThreadOrder, draggedThreadId, targetThreadId),
    ),
  setThreadGroupMembership: (currentThreadOrder, threadIds, target) =>
    set((state) => setThreadGroupMembership(state, currentThreadOrder, threadIds, target)), // fork-hook: thread-ordering/group-actions
  renameThreadGroup: (groupId, title) => set((state) => renameThreadGroup(state, groupId, title)), // fork-hook: thread-ordering/group-actions
  renameThreadGroupIfCurrent: (groupId, expected, title) =>
    set((state) => renameThreadGroupIfCurrent(state, groupId, expected, title)), // fork-hook: thread-ordering/group-actions
  setThreadGroupCollapsed: (groupId, collapsed) =>
    set((state) => setThreadGroupCollapsed(state, groupId, collapsed)), // fork-hook: thread-ordering/group-actions
  setThreadGroupParent: (groupId, parentThreadId) =>
    set((state) => setThreadGroupParent(state, groupId, parentThreadId)), // fork-hook: thread-ordering/group-actions
  removeThreadGroup: (groupId) => set((state) => removeThreadGroup(state, groupId)), // fork-hook: thread-ordering/group-actions
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));
forkWindowSidebarScope.install(useUiStateStore); // fork-hook: multi-window/window-sidebar-scope

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}

export { setSidebarProjectScopeKey }; // fork-hook: workspaces/sidebar-scope-key-export
