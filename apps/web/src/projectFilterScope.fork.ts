// What the window's project filter scopes, and what it never touches
// (RSI-Software/t3code-hyprws#1353). The filter narrows lists: the sidebar,
// the palette's thread and project search, and the new-thread picker. It never
// closes, redirects, or tears down work: a thread outside the filter stays
// open and offers to add its project, and turns, previews, and terminals are
// keyed by thread, not by filter.
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  projectFilterProjectKeys,
  type ProjectFilter,
} from "@t3tools/client-runtime/state/project-filter";
import type { ScopedProjectRef } from "@t3tools/contracts";

import { openCommandPalette } from "./commandPaletteBus";
import {
  resolveThreadActionProjectRef,
  type ChatThreadActionContext,
} from "./lib/chatThreadActions";
import { readProjectChooserHost, type ProjectChooserGroup } from "./projectChooser.fork";

const sameRef = (a: ScopedProjectRef, b: ScopedProjectRef) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId;

/**
 * The group to add when `projectRef` lies outside `filter`: `null` when the
 * filter shows every project, already shows it, or no current group carries it.
 */
export function outsideFilterProjectGroup<Group extends ProjectChooserGroup>(
  filter: ProjectFilter,
  groups: ReadonlyArray<Group>,
  projectRef: ScopedProjectRef,
): Group | null {
  const shown = projectFilterProjectKeys(
    filter,
    groups.flatMap((group) => group.memberProjectRefs),
  );
  if (shown === null || shown.has(scopedProjectKey(projectRef))) return null;
  return (
    groups.find((group) => group.memberProjectRefs.some((ref) => sameRef(ref, projectRef))) ?? null
  );
}

/** The filter with `group`'s entry added; `filter` itself when already selected. */
export function addProjectFilterEntry(
  filter: ProjectFilter,
  group: ProjectChooserGroup,
): ProjectFilter {
  if (filter.mode === "exclude") {
    const entries = filter.entries.filter((entry) => entry.key !== group.projectKey);
    return entries.length === filter.entries.length ? filter : { ...filter, entries };
  }
  if (filter.entries.some((entry) => entry.key === group.projectKey)) return filter;
  return {
    entries: [...filter.entries, { key: group.projectKey, members: group.memberProjectRefs }],
  };
}

export type FilteredNewThread =
  /** The filter shows every project: upstream's own resolution. */
  | { readonly kind: "default" }
  /** Create in this project without asking. */
  | { readonly kind: "project"; readonly projectRef: ScopedProjectRef }
  /** Several projects and no explicit one: ask with the scoped picker. */
  | { readonly kind: "choose" };

/**
 * Where a new thread goes under the window's filter. `contextProjectRef` is
 * the viewed thread or draft's project, never a fallback default. `direct` is
 * "new thread in the current project" (shift+click, `chat.newLocal`), which
 * names the viewed project explicitly; a plain new thread does not.
 *
 * - All projects: upstream's behavior.
 * - One entry: that entry's project, preferring the viewed member.
 * - Several entries: the viewed project when direct, else the picker. A
 *   member is never picked silently.
 */
export function resolveFilteredNewThread(input: {
  readonly filter: ProjectFilter;
  readonly contextProjectRef: ScopedProjectRef | null;
  readonly direct: boolean;
}): FilteredNewThread {
  const { filter, contextProjectRef, direct } = input;
  if (filter.entries.length === 0) return { kind: "default" };
  if (direct && contextProjectRef !== null) {
    return { kind: "project", projectRef: contextProjectRef };
  }
  if (filter.mode === "exclude" || filter.entries.length > 1) return { kind: "choose" };
  const members = filter.entries[0]!.members;
  const viewed =
    contextProjectRef === null
      ? undefined
      : members.find((member) => sameRef(member, contextProjectRef));
  const target = viewed ?? members[0];
  // An entry whose projects have not loaded names nothing to create in.
  return target === undefined ? { kind: "default" } : { kind: "project", projectRef: target };
}

type NewThreadContext = Pick<
  ChatThreadActionContext,
  "activeDraftThread" | "activeThread" | "defaultProjectRef"
>;

// The viewed thread or draft's project only: a fallback default is a silent pick.
const viewedProjectRef = (context: NewThreadContext): ScopedProjectRef | null =>
  resolveThreadActionProjectRef({ ...context, defaultProjectRef: null, handleNewThread: noop });
const noop = async () => {};

/**
 * Whether `chat.new` lands where "New thread in <current project>" does, so
 * the palette item may show its shortcut. Several projects open the picker
 * instead, and one project may name another than the viewed outside thread.
 */
export function chatNewMatchesCurrentProject(
  filter: ProjectFilter,
  context: NewThreadContext,
): boolean {
  const target = resolveFilteredNewThread({
    filter,
    contextProjectRef: viewedProjectRef(context),
    direct: false,
  });
  if (target.kind === "default") return true;
  if (target.kind === "choose") return false;
  const current = resolveThreadActionProjectRef({ ...context, handleNewThread: noop });
  return current !== null && sameRef(current, target.projectRef);
}

/**
 * Runs a new-thread request under the window's filter. Returns whether it
 * handled the request; `false` leaves upstream's resolution to run. Without
 * a chooser (no projects yet, or a route without the sidebar) nothing is
 * filtered.
 */
export function startFilteredNewThreadFork(
  context: ChatThreadActionContext,
  direct: boolean,
): boolean {
  const chooser = readProjectChooserHost();
  if (chooser === null) return false;
  const target = resolveFilteredNewThread({
    filter: chooser.filter,
    contextProjectRef: viewedProjectRef(context),
    direct,
  });
  if (target.kind === "default") return false;
  if (target.kind === "choose") openCommandPalette({ open: "new-thread-in" });
  else void context.handleNewThread(target.projectRef);
  return true;
}

/** `items` whose project the scope shows; every item when `projectKeys` is `null`. */
export function scopeToProjectKeys<Item>(
  items: ReadonlyArray<Item>,
  projectKeys: ReadonlySet<string> | null,
  projectKeysOf: (item: Item) => ReadonlyArray<string>,
): ReadonlyArray<Item> {
  if (projectKeys === null) return items;
  return items.filter((item) => projectKeysOf(item).some((key) => projectKeys.has(key)));
}
