// The window's project chooser (RSI-Software/t3code-hyprws#1352): a small
// adapter that turns the sidebar's single-select scope combobox into a
// multi-select over the window's `ProjectFilter`, plus the one open request
// every other surface (palette, keybinding, Issues and PR scope labels) sends
// to that same chooser.
import {
  ALL_PROJECTS_FILTER,
  type ProjectFilter,
  type ProjectFilterEntry,
} from "@t3tools/client-runtime/state/project-filter";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

/** Upstream's "All projects" item value in the scope combobox. */
export const ALL_PROJECTS_CHOOSER_VALUE = "all";

export interface ProjectChooserGroup {
  readonly projectKey: string;
  readonly displayName: string;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
}

export interface ProjectChooserItem {
  readonly value: string;
  readonly label: string;
  /** A selected entry no current group carries, e.g. while its server is offline. */
  readonly unavailable: boolean;
}

export interface ProjectChooserState<Group extends ProjectChooserGroup> {
  /** "All projects", every group, then each selected entry no group carries. */
  readonly items: ReadonlyArray<ProjectChooserItem>;
  /** The selected items; "All projects" alone when the filter is empty. */
  // Mutable because Base UI's multiple Combobox value prop takes a plain array.
  readonly value: ProjectChooserItem[];
  /** The header's name for the filter: "Projects: All", one name, or "N selected". */
  readonly label: string;
  /** The one selected group, when exactly one available entry is selected. */
  readonly single: Group | null;
  readonly count: number;
}

const ALL_ITEM: ProjectChooserItem = {
  value: ALL_PROJECTS_CHOOSER_VALUE,
  label: "All projects",
  unavailable: false,
};

// Grouped keys read as a path (`github.com/acme/web`); a physical key is an
// opaque id, so it gets a generic name.
function unavailableEntryLabel(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash >= 0 && slash < key.length - 1 ? key.slice(slash + 1) : "Unavailable project";
}

export function projectChooserState<Group extends ProjectChooserGroup>(
  filter: ProjectFilter,
  groups: ReadonlyArray<Group>,
): ProjectChooserState<Group> {
  const groupByKey = new Map(groups.map((group) => [group.projectKey, group] as const));
  const groupItems = groups.map((group): ProjectChooserItem => ({
    value: group.projectKey,
    label: group.displayName,
    unavailable: false,
  }));
  const unavailableItems = filter.entries
    .filter((entry) => !groupByKey.has(entry.key))
    .map((entry): ProjectChooserItem => ({
      value: entry.key,
      label: unavailableEntryLabel(entry.key),
      unavailable: true,
    }));
  const items = [ALL_ITEM, ...groupItems, ...unavailableItems];
  const itemByValue = new Map(items.map((item) => [item.value, item] as const));
  const value =
    filter.entries.length === 0
      ? [ALL_ITEM]
      : filter.entries.flatMap((entry) => {
          const item = itemByValue.get(entry.key);
          return item === undefined ? [] : [item];
        });
  const count = filter.entries.length;
  const only = count === 1 ? value[0] : undefined;
  return {
    items,
    value,
    label:
      count === 0
        ? "Projects: All"
        : only !== undefined
          ? `Projects: ${only.label}`
          : `Projects: ${count} selected`,
    single: only === undefined ? null : (groupByKey.get(only.value) ?? null),
    count,
  };
}

/**
 * The filter after the combobox reports `values`, the selection with one item
 * toggled. Picking "All projects" clears the filter; toggling a project adds or
 * removes its entry. Entries keep their members, so an offline entry the user
 * did not touch stays selected.
 */
export function projectFilterFromChooser(
  filter: ProjectFilter,
  values: ReadonlyArray<string>,
  groups: ReadonlyArray<ProjectChooserGroup>,
): ProjectFilter {
  const selected = new Set(filter.entries.map((entry) => entry.key));
  // "All projects" is in the selection only while the filter is empty, so
  // seeing it beside entries means the user just picked it.
  if (values.includes(ALL_PROJECTS_CHOOSER_VALUE) && filter.entries.length > 0) {
    return ALL_PROJECTS_FILTER;
  }
  const keys = new Set(values.filter((value) => value !== ALL_PROJECTS_CHOOSER_VALUE));
  const kept = filter.entries.filter((entry) => keys.has(entry.key));
  const added = groups
    .filter((group) => keys.has(group.projectKey) && !selected.has(group.projectKey))
    .map((group): ProjectFilterEntry => ({
      key: group.projectKey,
      members: group.memberProjectRefs,
    }));
  const entries = [...kept, ...added];
  if (entries.length === filter.entries.length && added.length === 0) return filter;
  return entries.length === 0 ? ALL_PROJECTS_FILTER : { entries };
}

/** A project row's Show only: the filter becomes that one project. */
export function showOnlyProjectFilter(group: ProjectChooserGroup): ProjectFilter {
  return { entries: [{ key: group.projectKey, members: group.memberProjectRefs }] };
}

// The chooser lives in the sidebar; the other surfaces reach it through this
// one host, which the sidebar registers while it is mounted.
interface ProjectChooserHost {
  readonly open: () => void;
  readonly label: string;
}

let host: ProjectChooserHost | null = null;
const listeners = new Set<() => void>();

function setHost(next: ProjectChooserHost | null) {
  host = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Registers the sidebar's chooser while mounted, so other surfaces can open it. */
export function useProjectChooserHost(open: () => void, label: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const registered: ProjectChooserHost = { open, label };
    setHost(registered);
    return () => {
      if (host === registered) setHost(null);
    };
  }, [enabled, label, open]);
}

/** The mounted chooser's label; `null` where no chooser serves this window. */
export function useProjectChooserLabel(): string | null {
  // No chooser is mounted during a server render.
  return useSyncExternalStore(
    subscribe,
    () => host?.label ?? null,
    () => null,
  );
}

/** Opens the sidebar's chooser. Returns whether one was there to open. */
export function openProjectChooser(): boolean {
  if (host === null) return false;
  host.open();
  return true;
}

/** Runs the chooser's keybinding. Returns whether `command` was it, so the caller stops matching. */
export function runProjectChooserCommandFork(
  command: string | null,
  event: KeyboardEvent,
): boolean {
  if (command !== "projectFilter.choose") return false;
  if (openProjectChooser()) {
    event.preventDefault();
    event.stopPropagation();
  }
  return true;
}
