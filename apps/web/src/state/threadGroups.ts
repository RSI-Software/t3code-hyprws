// Fork-owned sidebar thread groups (thread-ordering). Each environment's server
// owns its groups; this store mirrors them as scoped keys for the sidebar,
// applies edits optimistically through the same reducer the server runs, and
// keeps only the collapsed state on this client.
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createThreadGroupEnvironmentAtoms } from "@t3tools/client-runtime/state/thread-groups";
import {
  applyThreadGroupMutationFork,
  EnvironmentId,
  type ThreadGroupFork,
  type ThreadGroupMutationFork,
  ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { PERSISTED_STATE_KEY } from "../uiStateStore";
import { readLegacyThreadGroupsFork, splitLegacyThreadGroupsFork } from "./threadGroupsLegacy.fork";

export const threadGroupEnvironment = createThreadGroupEnvironmentAtoms(connectionAtomRuntime);

/** A group as the sidebar sees it: `id` and thread ids are environment-scoped keys. */
export interface SidebarThreadGroup {
  id: string;
  title: string;
  threadIds: string[];
  collapsed: boolean;
  /** A member shown first, with the rest indented under it. Visual only. */
  parentThreadId?: string;
}

export type SidebarThreadGroupMembershipTarget =
  | {
      readonly kind: "existing";
      readonly groupId: string;
      /** The one joining thread becomes the group's parent. */
      readonly asParent?: boolean;
    }
  | { readonly kind: "new"; readonly group: Pick<SidebarThreadGroup, "id" | "title"> }
  | { readonly kind: "none" };

const COLLAPSED_KEY = "t3code:thread-groups-collapsed:v1";
/** Groups this client kept before the server owned them, awaiting import. */
const IMPORT_KEY = "t3code:thread-groups-import:v1";

/** Groups share the scoped thread key form, `<environmentId>:<groupId>`. */
const groupKey = (environmentId: EnvironmentId, groupId: string) => `${environmentId}:${groupId}`;
function parseKey(key: string) {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  return {
    environmentId: EnvironmentId.make(key.slice(0, separator)),
    localId: key.slice(separator + 1),
  };
}

/** The groups a thread of this environment can join; a group never spans two. */
export function environmentThreadGroupsFork(
  groups: readonly SidebarThreadGroup[],
  environmentId: EnvironmentId,
): SidebarThreadGroup[] {
  return groups.filter((group) => parseKey(group.id)?.environmentId === environmentId);
}

/** A new group's key, in the environment of its first thread. */
export function newThreadGroupKeyFork(firstThreadKey: string): string {
  const environmentId = parseKey(firstThreadKey)?.environmentId ?? EnvironmentId.make("unknown");
  return groupKey(environmentId, randomUUID());
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {}
}

type GroupsByEnvironment = Readonly<Record<EnvironmentId, ReadonlyArray<ThreadGroupFork>>>;

interface ThreadGroupsState {
  /** Last server snapshot per environment that serves groups. */
  readonly confirmed: GroupsByEnvironment;
  /** `confirmed` plus edits still in flight. */
  readonly shown: GroupsByEnvironment;
  readonly collapsed: Readonly<Record<string, true>>;
  readonly threadGroups: SidebarThreadGroup[];
}

function flatten(
  shown: GroupsByEnvironment,
  collapsed: Readonly<Record<string, true>>,
): SidebarThreadGroup[] {
  return Object.entries(shown).flatMap(([environmentId, groups]) =>
    groups.map((group) => {
      const environment = EnvironmentId.make(environmentId);
      const key = groupKey(environment, group.id);
      const threadKey = (threadId: ThreadId) =>
        scopedThreadKey(scopeThreadRef(environment, threadId));
      return {
        id: key,
        title: group.title,
        threadIds: group.threadIds.map(threadKey),
        collapsed: collapsed[key] === true,
        ...(group.parentThreadId === undefined
          ? {}
          : { parentThreadId: threadKey(group.parentThreadId) }),
      };
    }),
  );
}

const initialCollapsed = (() => {
  const stored = readJson(COLLAPSED_KEY);
  if (stored === null || typeof stored !== "object") return {};
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, true] => entry[1] === true),
  );
})();

export const useThreadGroupStoreFork = create<ThreadGroupsState>(() => ({
  confirmed: {},
  shown: {},
  collapsed: initialCollapsed,
  threadGroups: [],
}));

function update(next: Partial<Omit<ThreadGroupsState, "threadGroups">>) {
  useThreadGroupStoreFork.setState((state) => {
    const shown = next.shown ?? state.shown;
    const collapsed = next.collapsed ?? state.collapsed;
    if (next.collapsed !== undefined) writeJson(COLLAPSED_KEY, collapsed);
    return { ...next, threadGroups: flatten(shown, collapsed) };
  });
}

function setCollapsed(key: string, collapsed: boolean) {
  const current = useThreadGroupStoreFork.getState().collapsed;
  if ((current[key] === true) === collapsed) return;
  const { [key]: _previous, ...rest } = current;
  update({ collapsed: collapsed ? { ...rest, [key]: true } : rest });
}

function applySnapshot(environmentId: EnvironmentId, groups: ReadonlyArray<ThreadGroupFork>) {
  const { confirmed, shown, collapsed } = useThreadGroupStoreFork.getState();
  const live = new Set(groups.map((group) => groupKey(environmentId, group.id)));
  const stale = Object.keys(collapsed).filter(
    (key) => parseKey(key)?.environmentId === environmentId && !live.has(key),
  );
  update({
    confirmed: { ...confirmed, [environmentId]: groups },
    shown: { ...shown, [environmentId]: groups },
    ...(stale.length === 0
      ? {}
      : {
          collapsed: Object.fromEntries(
            Object.entries(collapsed).filter(([key]) => !stale.includes(key)),
          ),
        }),
  });
}

/** Shows the edit at once, then settles on the server's answer or rolls back. */
function mutate(environmentId: EnvironmentId, mutation: ThreadGroupMutationFork) {
  const current = useThreadGroupStoreFork.getState().shown[environmentId];
  // An environment without the fork capability, or not yet loaded, has no groups to edit.
  if (current === undefined) return;
  const result = applyThreadGroupMutationFork(current, mutation, randomUUID);
  if ("error" in result) return;
  update({
    shown: { ...useThreadGroupStoreFork.getState().shown, [environmentId]: result.groups },
  });
  void runAtomCommand(appAtomRegistry, threadGroupEnvironment.mutate, {
    environmentId,
    input: mutation,
  }).then((settled) => {
    if (settled._tag === "Success") return applySnapshot(environmentId, settled.value.groups);
    applySnapshot(environmentId, useThreadGroupStoreFork.getState().confirmed[environmentId] ?? []);
    if (!isAtomCommandInterrupted(settled)) {
      const error = squashAtomCommandFailure(settled);
      toastManager.add({
        type: "error",
        title: "Thread group change failed",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/** Splits scoped thread keys by environment; edits never span two. */
function localThreadIds(keys: readonly string[]) {
  const refs = keys.map(parseScopedThreadKey);
  const environmentId = refs[0]?.environmentId;
  if (environmentId === undefined) return null;
  const threadIds: ThreadId[] = [];
  for (const ref of refs) {
    if (ref === null || ref.environmentId !== environmentId) return null;
    threadIds.push(ref.threadId);
  }
  return { environmentId, threadIds };
}

export function setThreadGroupMembership(
  threadKeys: readonly string[],
  target: SidebarThreadGroupMembershipTarget,
) {
  const local = localThreadIds(threadKeys);
  const [first, ...rest] = local?.threadIds ?? [];
  if (local === null || first === undefined) return;
  const targetKey =
    target.kind === "existing" ? target.groupId : target.kind === "new" ? target.group.id : null;
  const group = targetKey === null ? null : parseKey(targetKey);
  if (group !== null && group.environmentId !== local.environmentId) return;
  if (target.kind === "existing" && targetKey !== null) setCollapsed(targetKey, false);
  mutate(local.environmentId, {
    type: "set-membership",
    threadIds: [first, ...rest],
    target:
      target.kind === "none" || group === null
        ? { type: "none" }
        : target.kind === "existing"
          ? {
              type: "existing",
              groupId: group.localId,
              ...(target.asParent ? { asParent: true } : {}),
            }
          : { type: "new", groupId: group.localId, title: target.group.title },
  });
}

export function renameThreadGroupIfCurrent(
  key: string,
  expected: Pick<SidebarThreadGroup, "title" | "threadIds">,
  title: string,
) {
  const group = parseKey(key);
  const trimmed = title.trim();
  if (group === null || trimmed.length === 0) return;
  mutate(group.environmentId, {
    type: "rename",
    groupId: group.localId,
    title: trimmed,
    expected: {
      title: expected.title,
      threadIds: expected.threadIds.flatMap(
        (threadKey) => parseScopedThreadKey(threadKey)?.threadId ?? [],
      ),
    },
  });
}

export function renameThreadGroup(key: string, title: string) {
  const group = parseKey(key);
  const trimmed = title.trim();
  if (group === null || trimmed.length === 0) return;
  mutate(group.environmentId, { type: "rename", groupId: group.localId, title: trimmed });
}

export function setThreadGroupParent(key: string, parentThreadKey: string | null) {
  const group = parseKey(key);
  if (group === null) return;
  const parent = parentThreadKey === null ? null : parseScopedThreadKey(parentThreadKey);
  if (parent !== null && parent.environmentId !== group.environmentId) return;
  mutate(group.environmentId, {
    type: "set-parent",
    groupId: group.localId,
    parentThreadId: parent?.threadId ?? null,
  });
}

export function removeThreadGroup(key: string) {
  const group = parseKey(key);
  if (group === null) return;
  setCollapsed(key, false);
  mutate(group.environmentId, { type: "remove", groupId: group.localId });
}

export function setThreadGroupCollapsed(key: string, collapsed: boolean) {
  setCollapsed(key, collapsed);
}

/**
 * Groups used to live in this client's UI state. They move to a key of their
 * own once, so the UI store can stop carrying them, and each environment
 * adopts its share the first time it serves groups.
 */
function takeLegacyGroups() {
  if (readJson(IMPORT_KEY) !== null) return;
  writeJson(IMPORT_KEY, readLegacyThreadGroupsFork(readJson(PERSISTED_STATE_KEY)));
}
takeLegacyGroups();

function importLegacyGroups(environmentId: EnvironmentId) {
  const { share, remaining } = splitLegacyThreadGroupsFork(readJson(IMPORT_KEY), environmentId);
  if (share.length === 0) {
    writeJson(IMPORT_KEY, remaining);
    return;
  }
  void runAtomCommand(appAtomRegistry, threadGroupEnvironment.mutate, {
    environmentId,
    input: { type: "import", groups: share.map(({ imported }) => imported) },
  }).then((settled) => {
    if (settled._tag !== "Success") return;
    // Read again: another environment may have taken its share meanwhile.
    writeJson(
      IMPORT_KEY,
      splitLegacyThreadGroupsFork(readJson(IMPORT_KEY), environmentId).remaining,
    );
    applySnapshot(environmentId, settled.value.groups);
    for (const { imported, collapsed } of share) {
      if (collapsed) setCollapsed(groupKey(environmentId, imported.id), true);
    }
  });
}

/** Called by the per-environment sync with each server snapshot. */
export function receiveThreadGroupsSnapshotFork(
  environmentId: EnvironmentId,
  groups: ReadonlyArray<ThreadGroupFork>,
) {
  const first = useThreadGroupStoreFork.getState().confirmed[environmentId] === undefined;
  applySnapshot(environmentId, groups);
  if (first) importLegacyGroups(environmentId);
}

/** Drops environments that left the client, or stopped serving groups. */
export function retainThreadGroupEnvironmentsFork(environmentIds: ReadonlySet<EnvironmentId>) {
  const { confirmed, shown } = useThreadGroupStoreFork.getState();
  const keep = <T>(record: Readonly<Record<EnvironmentId, T>>) =>
    Object.fromEntries(
      Object.entries(record).filter(([environmentId]) =>
        environmentIds.has(EnvironmentId.make(environmentId)),
      ),
    ) as Record<EnvironmentId, T>;
  if (Object.keys(confirmed).every((id) => environmentIds.has(EnvironmentId.make(id)))) return;
  update({ confirmed: keep(confirmed), shown: keep(shown) });
}
