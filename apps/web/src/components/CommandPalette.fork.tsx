// Fork-owned: the command-palette "Go to Issues" entry for commit `9f92309411`
// (feat(issues): add GitHub Issues surface scoped to project windows). The
// upstream `CommandPalette.tsx` carries only marked hook lines pointing here;
// the capability probe, the navigation command, and the action item are built
// in this module.
import { projectFilterProjectKeys } from "@t3tools/client-runtime/state/project-filter";
import { CircleDotIcon, ListFilterIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { openProjectChooser, useProjectChooserHostValue } from "../projectChooser.fork";
import { chatNewMatchesCurrentProject, scopeToProjectKeys } from "../projectFilterScope.fork";
import type { ChatThreadActionContext } from "../lib/chatThreadActions";
import {
  enumerateCommandPaletteItems,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
} from "./CommandPalette.logic";
import type { ScopedProjectRef } from "@t3tools/contracts";

/**
 * The palette's Issues navigation entry, or `null` when no reachable
 * environment advertises the read-only GitHub Issues capability.
 */
export function buildGitHubIssuesActionItemFork(input: {
  environments: ReadonlyArray<{
    readonly serverConfig?: {
      readonly environment: { readonly capabilities: { readonly githubIssues?: boolean } };
    } | null;
  }>;
  navigate: (options: never) => Promise<void>;
}): CommandPaletteActionItem | null {
  const githubIssuesSupported = input.environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.githubIssues === true,
  );
  if (!githubIssuesSupported) return null;
  return {
    kind: "action",
    value: "action:issues",
    searchTerms: ["issues", "github", "bugs", "go to"],
    title: "Go to Issues",
    icon: <CircleDotIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await input.navigate({ to: "/issues", search: { state: "open" } } as never);
    },
  };
}

/**
 * The palette's "Choose projects" entry (RSI-Software/t3code-hyprws#1352), or
 * `null` where no sidebar chooser serves this window (`label` is `null`).
 */
export function buildProjectChooserActionItemFork(
  label: string | null,
): CommandPaletteActionItem | null {
  if (label === null) return null;
  return {
    kind: "action",
    value: "action:choose-projects",
    searchTerms: ["projects", "filter", "choose", "scope", "sidebar", "select"],
    title: "Choose projects",
    description: label,
    icon: <ListFilterIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "projectFilter.choose",
    run: async () => {
      // Open once the palette has closed, so its focus return does not land after.
      requestAnimationFrame(() => {
        openProjectChooser();
      });
    },
  };
}

// The palette under the window's project filter (RSI-Software/t3code-hyprws#1353):
// thread search, project search, and the new-thread picker show the filter's
// projects until the user picks "Search all projects", which lasts until the
// palette closes. Without a chooser (no projects yet, or a route without the
// sidebar) nothing is scoped.

// The new-thread picker view `CommandPalette.tsx` pushes.
const NEW_THREAD_IN_VIEW = "projects";

export interface CommandPaletteProjectScope {
  /** The project keys the palette shows; `null` shows every project. */
  readonly projectKeys: ReadonlySet<string> | null;
  /** The toggle between the filter and every project; `null` when unscoped. */
  readonly toggle: CommandPaletteActionItem | null;
}

export function useCommandPaletteProjectScopeFork(): CommandPaletteProjectScope {
  const chooser = useProjectChooserHostValue();
  const filter = chooser?.filter ?? null;
  const label = chooser?.label ?? null;
  const [searchAll, setSearchAll] = useState(false);
  const filterKeys = useMemo(
    () => (filter === null ? null : projectFilterProjectKeys(filter)),
    [filter],
  );
  return useMemo(() => {
    if (filterKeys === null || label === null) return { projectKeys: null, toggle: null };
    const toggle: CommandPaletteActionItem = searchAll
      ? {
          kind: "action",
          value: "action:search-filtered-projects",
          searchTerms: [],
          title: "Search only this window's projects",
          description: label,
          icon: <ListFilterIcon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => setSearchAll(false),
        }
      : {
          kind: "action",
          value: "action:search-all-projects",
          searchTerms: [],
          title: "Search all projects",
          description: label,
          icon: <SearchIcon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => setSearchAll(true),
        };
    return { projectKeys: searchAll ? null : filterKeys, toggle };
  }, [filterKeys, label, searchAll]);
}

/**
 * Whether "New thread in <current project>" may show the `chat.new` hint: the
 * shortcut must land where the item does.
 */
export function useNewThreadHintFork(
  activeDraftThread: ChatThreadActionContext["activeDraftThread"],
  activeThread: ChatThreadActionContext["activeThread"] | null,
  defaultProjectRef: ChatThreadActionContext["defaultProjectRef"],
): boolean {
  const filter = useProjectChooserHostValue()?.filter ?? null;
  return useMemo(
    () =>
      filter === null ||
      chatNewMatchesCurrentProject(filter, {
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef,
      }),
    [activeDraftThread, activeThread, defaultProjectRef, filter],
  );
}

/** Drops the `chat.new` hint from "New thread in <current project>" when it would mislead. */
export function dropNewThreadHintFork(
  items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem>,
  showHint: boolean,
): void {
  if (showHint) return;
  const index = items.findIndex((item) => item.value === "action:new-thread");
  const item = items[index];
  if (item === undefined || item.kind !== "action") return;
  const { shortcutCommand: _hint, ...withoutHint } = item;
  items[index] = withoutHint;
}

/** The palette's threads under the scope. */
export function useScopedPaletteThreadsFork<
  Thread extends { readonly environmentId: string; readonly projectId: string },
>(threads: ReadonlyArray<Thread>, projectKeys: ReadonlySet<string> | null) {
  return useMemo(
    () =>
      scopeToProjectKeys(threads, projectKeys, (thread) => [
        `${thread.environmentId}:${thread.projectId}`,
      ]),
    [projectKeys, threads],
  );
}

/**
 * The palette's project picker entries under the scope. A scope that leaves no
 * entry (its projects not loaded yet) shows every project, so the picker is
 * never empty.
 */
export function scopePaletteProjectEntriesFork<
  Entry extends { readonly group: { readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef> } },
>(entries: ReadonlyArray<Entry>, projectKeys: ReadonlySet<string> | null): ReadonlyArray<Entry> {
  const scoped = scopeToProjectKeys(entries, projectKeys, (entry) =>
    entry.group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
  );
  return scoped.length > 0 ? scoped : entries;
}

/**
 * The new-thread picker view follows the scope after it was pushed: its items
 * become the current picker items, keeping the pushed first item (the current
 * project) first. Other views pass through.
 */
export function refreshNewThreadInViewFork(
  groups: ReadonlyArray<CommandPaletteGroup>,
  projectThreadItems: ReadonlyArray<CommandPaletteActionItem>,
): ReadonlyArray<CommandPaletteGroup> {
  const view = groups[0];
  if (groups.length !== 1 || view?.value !== NEW_THREAD_IN_VIEW) return groups;
  const lead = view.items[0]?.value;
  const ordered = [
    ...projectThreadItems.filter((item) => item.value === lead),
    ...projectThreadItems.filter((item) => item.value !== lead),
  ];
  return [{ ...view, items: enumerateCommandPaletteItems(ordered) }];
}

/** Appends the scope toggle below the root list and the new-thread picker. */
export function withProjectScopeToggleFork(
  groups: CommandPaletteGroup[],
  scope: CommandPaletteProjectScope,
  currentView: CommandPaletteView | null,
): CommandPaletteGroup[] {
  if (scope.toggle === null) return groups;
  if (currentView !== null && currentView.groups[0]?.value !== NEW_THREAD_IN_VIEW) return groups;
  return [...groups, { value: "project-scope", label: "Scope", items: [scope.toggle] }];
}
