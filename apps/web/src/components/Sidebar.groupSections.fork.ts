import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  snoozeWakeLabel,
  threadRaisedHandWhileSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { SidebarThreadGroup } from "../state/threadGroups";
import type { planSidebarThreadDrop } from "./Sidebar.logic";

/** Snoozed parents carry quiet members; inbox members otherwise follow their parent's shelf. */
export function regroupSidebarSectionsFork<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(
  active: T[],
  working: T[],
  groups: readonly SidebarThreadGroup[],
  pinned: T[],
  workingEnabled: boolean,
  snooze?: { readonly snoozed: T[]; readonly canInheritSnooze: (thread: T) => boolean },
): void {
  if (groups.length === 0) return;
  const keyOf = (thread: T) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const isWorking = new Set(working.map(keyOf));
  const inbox = [...active, ...working];
  const pinnedKeys = new Set(pinned.map(keyOf));
  const carriedToPinned = new Set<string>();
  const snoozedKeys = new Set(snooze?.snoozed.map(keyOf));
  const carriedToSnoozed = new Set<string>();
  const shelved = new Map<string, boolean>();
  for (const group of groups) {
    if (snoozedKeys.has(group.parentThreadId)) {
      for (const thread of [...inbox, ...pinned]) {
        if (group.threadIds.includes(keyOf(thread)) && snooze?.canInheritSnooze(thread))
          carriedToSnoozed.add(keyOf(thread));
      }
      continue;
    }
    const members = inbox.map(keyOf).filter((key) => group.threadIds.includes(key));
    if (pinnedKeys.has(group.parentThreadId)) {
      for (const key of members) carriedToPinned.add(key);
      continue;
    }
    if (!workingEnabled || members.length < 2) continue;
    const toShelf = isWorking.has(group.parentThreadId);
    for (const key of members) shelved.set(key, toShelf);
  }
  const onShelf = (thread: T) => shelved.get(keyOf(thread)) ?? isWorking.has(keyOf(thread));
  const remaining = inbox.filter(
    (thread) => !carriedToPinned.has(keyOf(thread)) && !carriedToSnoozed.has(keyOf(thread)),
  );
  snooze?.snoozed.push(
    ...[...inbox, ...pinned].filter((thread) => carriedToSnoozed.has(keyOf(thread))),
  );
  pinned.splice(
    0,
    pinned.length,
    ...pinned.filter((thread) => !carriedToSnoozed.has(keyOf(thread))),
  );
  pinned.push(...inbox.filter((thread) => carriedToPinned.has(keyOf(thread))));
  active.splice(0, active.length, ...remaining.filter((thread) => !onShelf(thread)));
  working.splice(0, working.length, ...remaining.filter(onShelf));
}

export function inheritedSidebarSnoozeOwnersFork<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(threads: readonly T[], groups: readonly SidebarThreadGroup[], isSnoozed: (thread: T) => boolean) {
  const keyOf = (thread: T) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const actual = new Map(threads.filter(isSnoozed).map((thread) => [keyOf(thread), thread]));
  const present = new Set(threads.map(keyOf));
  const owners = new Map<string, T>();
  for (const group of groups) {
    const parent = actual.get(group.parentThreadId);
    if (parent === undefined) continue;
    for (const key of group.threadIds)
      if (present.has(key) && !actual.has(key)) owners.set(key, parent);
  }
  return owners;
}

export function inheritedSidebarSnoozePropsFork(
  threadKey: string,
  owners: ReadonlyMap<string, { readonly snoozedUntil: string | null }>,
  now: string,
) {
  const until = owners.get(threadKey)?.snoozedUntil;
  return until == null ? {} : { snoozeWakeLabelText: snoozeWakeLabel(until, { now }) };
}

/** Snoozed parents carry their quiet members, so forward navigation must skip them. */
export function groupSnoozeCarryKeysFork(
  threadKey: string,
  groups: readonly SidebarThreadGroup[],
  threadByKey: ReadonlyMap<string, Parameters<typeof threadRaisedHandWhileSnoozed>[0]>,
  coParkingKeys?: ReadonlySet<string>,
): ReadonlySet<string> {
  const carried = groups
    .filter(
      (group) => group.parentThreadId === threadKey || coParkingKeys?.has(group.parentThreadId),
    )
    .flatMap((group) => group.threadIds)
    .filter((key) => {
      const thread = threadByKey.get(key);
      return thread === undefined || !threadRaisedHandWhileSnoozed(thread);
    });
  return new Set([...(coParkingKeys ?? []), threadKey, ...carried]);
}

/** Independent child placement must not move its group ahead of its parent. */
export function anchorSidebarGroupsFork<T>(
  threads: readonly T[],
  groups: readonly SidebarThreadGroup[],
  getKey: (thread: T) => string,
): T[] {
  const ranks = new Map(threads.map((thread, index) => [getKey(thread), index]));
  const anchors = new Map<string, number>();
  for (const group of groups) {
    const rank = ranks.get(group.parentThreadId);
    if (rank === undefined) continue;
    for (const key of group.threadIds) anchors.set(key, rank);
  }
  const rank = (thread: T) => anchors.get(getKey(thread)) ?? ranks.get(getKey(thread))!;
  return threads.toSorted((left, right) => rank(left) - rank(right));
}

/** Inherited pins have no server pin order and must never receive pin reorders. */
export function normalizeGroupedSidebarThreadDropFork(
  input: Parameters<typeof planSidebarThreadDrop>[0],
) {
  const inherited = input.activeSection === "pinned" && input.activePinned === false;
  if (inherited && input.target.section === "pinned" && input.keepInheritedPin)
    return {
      ...input,
      activeSection: "active" as const,
      activeTimeOrdered: true,
      target: { ...input.target, section: "active" as const },
    };
  const pinned = new Set(input.pinnedOrder);
  return {
    ...input,
    activeSection: inherited ? ("active" as const) : input.activeSection,
    target: {
      ...input.target,
      pinnedOrder: input.target.pinnedOrder.filter(
        (key) => key === input.activeKey || pinned.has(key),
      ),
    },
  };
}
