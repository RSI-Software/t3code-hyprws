import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";

export const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
const THREAD_CHANGED_FILES_EXPANSION_VERSION = 1;
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
  threadGroupsByProject?: Record<string, SidebarThreadGroup[]>;
  threadLastVisitedAtById?: Record<string, string>;
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  threadChangedFilesExpansionVersion?: typeof THREAD_CHANGED_FILES_EXPANSION_VERSION;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
}

export interface SidebarThreadGroup {
  id: string;
  title: string;
  threadIds: string[];
  collapsed: boolean;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
}

export interface UiThreadState {
  threadOrderByProject: Record<string, string[]>;
  threadGroupsByProject: Record<string, SidebarThreadGroup[]>;
  threadLastVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export interface UiState extends UiProjectState, UiThreadState, UiEndpointState {}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  threadOrderByProject: {},
  threadGroupsByProject: {},
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
  defaultAdvertisedEndpointKey: null,
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

function sanitizeThreadGroupRecord(value: unknown): Record<string, SidebarThreadGroup[]> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, SidebarThreadGroup[]> = {};
  for (const [projectKey, groups] of Object.entries(value)) {
    if (!projectKey || !Array.isArray(groups)) continue;
    const usedThreadIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const sanitized = groups.flatMap((group): SidebarThreadGroup[] => {
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
        },
      ];
    });
    if (sanitized.length > 0) result[projectKey] = sanitized;
  }
  return result;
}

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
    threadGroupsByProject: sanitizeThreadGroupRecord(parsed.threadGroupsByProject),
    threadLastVisitedAtById: sanitizeTimestampRecord(parsed.threadLastVisitedAtById),
    threadChangedFilesExpandedById:
      parsed.threadChangedFilesExpansionVersion === THREAD_CHANGED_FILES_EXPANSION_VERSION
        ? sanitizePersistedThreadChangedFilesExpanded(parsed.threadChangedFilesExpandedById)
        : {},
    defaultAdvertisedEndpointKey:
      typeof parsed.defaultAdvertisedEndpointKey === "string" &&
      parsed.defaultAdvertisedEndpointKey.length > 0
        ? parsed.defaultAdvertisedEndpointKey
        : null,
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
        threadOrderByProject: state.threadOrderByProject,
        threadGroupsByProject: state.threadGroupsByProject,
        threadLastVisitedAtById: state.threadLastVisitedAtById,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        threadChangedFilesExpansionVersion: THREAD_CHANGED_FILES_EXPANSION_VERSION,
        threadChangedFilesExpandedById: state.threadChangedFilesExpandedById,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
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

export function setThreadChangedFilesExpanded(
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

export function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
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

export function moveProjectThread(
  state: UiState,
  projectKey: string,
  currentThreadOrder: readonly string[],
  draggedThreadId: string,
  targetThreadId: string,
  mode: SidebarThreadDropMode,
  newGroup?: { readonly id: string; readonly title: string },
): UiState {
  const reordered = reorderProjectThreads(
    state,
    projectKey,
    currentThreadOrder,
    draggedThreadId,
    targetThreadId,
  );
  if (reordered === state) return state;

  const threadOrder = reordered.threadOrderByProject[projectKey] ?? [...currentThreadOrder];
  const currentGroups = state.threadGroupsByProject[projectKey] ?? [];
  const sourceGroup = currentGroups.find((group) => group.threadIds.includes(draggedThreadId));
  const targetGroup = currentGroups.find((group) => group.threadIds.includes(targetThreadId));
  let groups = currentGroups.map((group) => ({ ...group, threadIds: [...group.threadIds] }));

  const removeDraggedFromSource = () => {
    groups = groups.map((group) =>
      group.id === sourceGroup?.id
        ? { ...group, threadIds: group.threadIds.filter((id) => id !== draggedThreadId) }
        : group,
    );
  };

  if (mode === "group") {
    removeDraggedFromSource();
    if (targetGroup) {
      groups = groups.map((group) =>
        group.id === targetGroup.id
          ? {
              ...group,
              threadIds: orderedGroupThreadIds([...group.threadIds, draggedThreadId], threadOrder),
            }
          : group,
      );
    } else if (newGroup) {
      groups.push({
        id: newGroup.id,
        title: newGroup.title,
        threadIds: orderedGroupThreadIds([targetThreadId, draggedThreadId], threadOrder),
        collapsed: false,
      });
    }
  } else if (sourceGroup && sourceGroup.id !== targetGroup?.id) {
    removeDraggedFromSource();
  }

  groups = groups
    .map((group) => ({
      ...group,
      threadIds: orderedGroupThreadIds(group.threadIds, threadOrder),
    }))
    .filter((group) => group.threadIds.length >= 2);

  return {
    ...reordered,
    threadGroupsByProject: {
      ...state.threadGroupsByProject,
      [projectKey]: groups,
    },
  };
}

export type SidebarThreadGroupMembershipTarget =
  | { readonly kind: "existing"; readonly groupId: string }
  | { readonly kind: "new"; readonly group: Pick<SidebarThreadGroup, "id" | "title"> }
  | { readonly kind: "none" };

export function setThreadGroupMembership(
  state: UiState,
  projectKey: string,
  currentThreadOrder: readonly string[],
  threadIds: readonly string[],
  target: SidebarThreadGroupMembershipTarget,
): UiState {
  const orderedThreadIds = orderedGroupThreadIds([...new Set(threadIds)], currentThreadOrder);
  if (orderedThreadIds.length === 0 || (target.kind === "new" && orderedThreadIds.length < 2)) {
    return state;
  }

  const currentGroups = state.threadGroupsByProject[projectKey] ?? [];
  if (target.kind === "existing" && !currentGroups.some((group) => group.id === target.groupId)) {
    return state;
  }
  const movingIds = new Set(orderedThreadIds);
  let groups = currentGroups.map((group) => ({
    ...group,
    threadIds: group.threadIds.filter((threadId) => !movingIds.has(threadId)),
  }));

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
    groups.every((group, index) => {
      const current = currentGroups[index];
      return (
        current?.id === group.id &&
        current.title === group.title &&
        current.collapsed === group.collapsed &&
        current.threadIds.length === group.threadIds.length &&
        current.threadIds.every(
          (threadId, threadIndex) => group.threadIds[threadIndex] === threadId,
        )
      );
    })
  ) {
    return state;
  }

  return {
    ...state,
    threadGroupsByProject: {
      ...state.threadGroupsByProject,
      [projectKey]: groups,
    },
  };
}

export function renameThreadGroup(
  state: UiState,
  projectKey: string,
  groupId: string,
  title: string,
): UiState {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return state;
  const groups = state.threadGroupsByProject[projectKey] ?? [];
  if (!groups.some((group) => group.id === groupId && group.title !== trimmedTitle)) return state;
  return {
    ...state,
    threadGroupsByProject: {
      ...state.threadGroupsByProject,
      [projectKey]: groups.map((group) =>
        group.id === groupId ? { ...group, title: trimmedTitle } : group,
      ),
    },
  };
}

export function renameThreadGroupIfCurrent(
  state: UiState,
  projectKey: string,
  groupId: string,
  expected: Pick<SidebarThreadGroup, "title" | "threadIds">,
  title: string,
): UiState {
  const group = (state.threadGroupsByProject[projectKey] ?? []).find(
    (candidate) => candidate.id === groupId,
  );
  if (
    !group ||
    group.title !== expected.title ||
    group.threadIds.length !== expected.threadIds.length ||
    expected.threadIds.some((threadId) => !group.threadIds.includes(threadId))
  ) {
    return state;
  }
  return renameThreadGroup(state, projectKey, groupId, title);
}

export function setThreadGroupCollapsed(
  state: UiState,
  projectKey: string,
  groupId: string,
  collapsed: boolean,
): UiState {
  const groups = state.threadGroupsByProject[projectKey] ?? [];
  if (!groups.some((group) => group.id === groupId && group.collapsed !== collapsed)) return state;
  return {
    ...state,
    threadGroupsByProject: {
      ...state.threadGroupsByProject,
      [projectKey]: groups.map((group) => (group.id === groupId ? { ...group, collapsed } : group)),
    },
  };
}

export function removeThreadGroup(state: UiState, projectKey: string, groupId: string): UiState {
  const groups = state.threadGroupsByProject[projectKey] ?? [];
  const nextGroups = groups.filter((group) => group.id !== groupId);
  if (nextGroups.length === groups.length) return state;
  return {
    ...state,
    threadGroupsByProject: { ...state.threadGroupsByProject, [projectKey]: nextGroups },
  };
}

interface UiStateStore extends UiState {
  markThreadVisited: (threadId: string, visitedAt: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
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
  moveProjectThread: (
    projectKey: string,
    currentThreadOrder: readonly string[],
    draggedThreadId: string,
    targetThreadId: string,
    mode: SidebarThreadDropMode,
    newGroup?: { readonly id: string; readonly title: string },
  ) => void;
  setThreadGroupMembership: (
    projectKey: string,
    currentThreadOrder: readonly string[],
    threadIds: readonly string[],
    target: SidebarThreadGroupMembershipTarget,
  ) => void;
  renameThreadGroup: (projectKey: string, groupId: string, title: string) => void;
  renameThreadGroupIfCurrent: (
    projectKey: string,
    groupId: string,
    expected: Pick<SidebarThreadGroup, "title" | "threadIds">,
    title: string,
  ) => void;
  setThreadGroupCollapsed: (projectKey: string, groupId: string, collapsed: boolean) => void;
  removeThreadGroup: (projectKey: string, groupId: string) => void;
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
  moveProjectThread: (
    projectKey,
    currentThreadOrder,
    draggedThreadId,
    targetThreadId,
    mode,
    newGroup,
  ) =>
    set((state) =>
      moveProjectThread(
        state,
        projectKey,
        currentThreadOrder,
        draggedThreadId,
        targetThreadId,
        mode,
        newGroup,
      ),
    ),
  setThreadGroupMembership: (projectKey, currentThreadOrder, threadIds, target) =>
    set((state) =>
      setThreadGroupMembership(state, projectKey, currentThreadOrder, threadIds, target),
    ),
  renameThreadGroup: (projectKey, groupId, title) =>
    set((state) => renameThreadGroup(state, projectKey, groupId, title)),
  renameThreadGroupIfCurrent: (projectKey, groupId, expected, title) =>
    set((state) => renameThreadGroupIfCurrent(state, projectKey, groupId, expected, title)),
  setThreadGroupCollapsed: (projectKey, groupId, collapsed) =>
    set((state) => setThreadGroupCollapsed(state, projectKey, groupId, collapsed)),
  removeThreadGroup: (projectKey, groupId) =>
    set((state) => removeThreadGroup(state, projectKey, groupId)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
