import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { SidebarThreadGroup } from "../state/threadGroups";
import { buildSidebarThreadGroupLayout } from "./Sidebar.logic";
import { sidebarThreadGroupSpansFork } from "./SidebarThreadGroup.span";

// Upstream's Working shelf takes each working thread out of the inbox. A group
// moves whole instead, following its parent: a working parent carries the group
// to the shelf, and a working child stays home under an idle parent.

/** Moves grouped inbox threads between the active list and the shelf, whole groups at a time. */
export function regroupWorkingShelfFork<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(active: T[], working: T[], groups: readonly SidebarThreadGroup[]): void {
  if (groups.length === 0) return;
  const keyOf = (thread: T) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const isWorking = new Set(working.map(keyOf));
  const inbox = [...active, ...working];
  const shelved = new Map<string, boolean>();
  for (const group of groups) {
    const members = inbox.map(keyOf).filter((key) => group.threadIds.includes(key));
    // Below two inbox members the group does not render; each thread places itself.
    if (members.length < 2) continue;
    const toShelf = isWorking.has(group.parentThreadId);
    for (const key of members) shelved.set(key, toShelf);
  }
  const onShelf = (thread: T) => shelved.get(keyOf(thread)) ?? isWorking.has(keyOf(thread));
  active.splice(0, active.length, ...inbox.filter((thread) => !onShelf(thread)));
  working.splice(0, working.length, ...inbox.filter(onShelf));
}

/** The shelf's group layout, its rendered threads, and its group spans. */
export function workingShelfGroupsFork<T>(
  threads: readonly T[],
  groups: readonly SidebarThreadGroup[],
  getKey: (thread: T) => string,
) {
  const layout = buildSidebarThreadGroupLayout({ threads, groups, getId: getKey });
  const visibleThreads = layout.flatMap((item) =>
    item.kind === "thread"
      ? [item.thread]
      : item.group.collapsed
        ? item.threads.slice(0, 1)
        : item.threads,
  );
  return { layout, visibleThreads, spans: sidebarThreadGroupSpansFork(layout, getKey) };
}
