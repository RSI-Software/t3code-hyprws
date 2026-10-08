// A window's project filter (RSI-Software/t3code-hyprws#1338): any number of
// scope-dropdown entries, each keeping the project refs it stands for. An
// empty filter shows every project. The filter is client-local; each client
// stores it and reconciles it against its current project groups.
import { ScopedProjectRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { scopedProjectKey } from "../environment/scoped.ts";

/** One selected scope-dropdown entry: a project or a grouped entry. */
export interface ProjectFilterEntry {
  readonly key: string;
  readonly members: ReadonlyArray<ScopedProjectRef>;
}

/** Empty entries show all projects; absent mode preserves legacy inclusion filters. */
export interface ProjectFilter {
  readonly mode?: "include" | "exclude";
  readonly entries: ReadonlyArray<ProjectFilterEntry>;
}

/** A scope-dropdown entry as the client currently groups projects. */
export type ProjectFilterGroup = ProjectFilterEntry;

export const ALL_PROJECTS_FILTER: ProjectFilter = { entries: [] };

const sameRef = (a: ScopedProjectRef, b: ScopedProjectRef) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId;

const sameEntry = (a: ProjectFilterEntry, b: ProjectFilterEntry) =>
  a.key === b.key &&
  a.members.length === b.members.length &&
  a.members.every((member, index) => sameRef(member, b.members[index]!));

/**
 * The single-select chooser's pick as a filter: one entry, or all projects.
 * A key the groups do not carry yet keeps no members until reconciled.
 */
export function projectFilterFromKey(
  key: string | null,
  groups: ReadonlyArray<ProjectFilterGroup> = [],
): ProjectFilter {
  if (key === null) return ALL_PROJECTS_FILTER;
  const group = groups.find((candidate) => candidate.key === key);
  return { entries: [{ key, members: group?.members ?? [] }] };
}

/** The single-select chooser's value: the one entry's key, else `null`. */
export function projectFilterScopeKey(filter: ProjectFilter): string | null {
  return filter.mode !== "exclude" && filter.entries.length === 1 ? filter.entries[0]!.key : null;
}

/** The keys shown; exclusion uses the current catalog so future projects remain visible. `null` means all. */
export function projectFilterProjectKeys(
  filter: ProjectFilter,
  available: ReadonlyArray<ScopedProjectRef> = [],
): ReadonlySet<string> | null {
  if (filter.entries.length === 0) return null;
  const selected = new Set(filter.entries.flatMap((entry) => entry.members.map(scopedProjectKey)));
  return filter.mode === "exclude"
    ? new Set(available.map(scopedProjectKey).filter((key) => !selected.has(key)))
    : selected;
}

/**
 * Follows the filter onto the current groups. An entry whose group still
 * exists takes its members, so new members join. An entry whose key is gone
 * becomes the groups now holding its members, so a grouping change re-maps
 * it. An entry nothing resolves stays selected until the project list is
 * `settled`, because an offline environment cannot prove its project gone;
 * once settled it is dropped, and dropping the last entry returns to all.
 * Returns `filter` itself when nothing changed.
 */
export function reconcileProjectFilter(
  filter: ProjectFilter,
  groups: ReadonlyArray<ProjectFilterGroup>,
  settled: boolean,
): ProjectFilter {
  if (filter.entries.length === 0) return filter;
  const groupByKey = new Map(groups.map((group) => [group.key, group] as const));
  const groupByMember = new Map<string, ProjectFilterGroup>();
  for (const group of groups) {
    for (const member of group.members) groupByMember.set(scopedProjectKey(member), group);
  }
  const entries: ProjectFilterEntry[] = [];
  const add = (entry: ProjectFilterEntry) => {
    if (!entries.some((existing) => existing.key === entry.key)) entries.push(entry);
  };
  for (const entry of filter.entries) {
    const group = groupByKey.get(entry.key);
    if (group !== undefined) {
      add({ key: group.key, members: group.members });
      continue;
    }
    const regrouped = entry.members.flatMap((member) => {
      const target = groupByMember.get(scopedProjectKey(member));
      return target === undefined ? [] : [target];
    });
    if (regrouped.length > 0) {
      for (const target of regrouped) add({ key: target.key, members: target.members });
      continue;
    }
    if (!settled) add(entry);
  }
  const unchanged =
    entries.length === filter.entries.length &&
    entries.every((entry, index) => sameEntry(entry, filter.entries[index]!));
  return unchanged ? filter : { ...filter, entries };
}

const StoredFilter = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["include", "exclude"])),
  entries: Schema.Array(Schema.Unknown),
});
const StoredEntry = Schema.Struct({
  key: Schema.String.check(Schema.isNonEmpty()),
  members: Schema.Array(Schema.Unknown),
});
const decodeStoredFilter = Schema.decodeUnknownOption(StoredFilter);
const decodeStoredEntry = Schema.decodeUnknownOption(StoredEntry);
const decodeRef = Schema.decodeUnknownOption(ScopedProjectRef);

/** Reads a stored filter, dropping malformed entries; `null` when unreadable. */
export function decodeProjectFilter(value: unknown): ProjectFilter | null {
  const stored = decodeStoredFilter(value);
  if (Option.isNone(stored)) return null;
  return {
    ...(stored.value.mode === undefined ? {} : { mode: stored.value.mode }),
    entries: stored.value.entries.flatMap((raw) => {
      const entry = decodeStoredEntry(raw);
      if (Option.isNone(entry)) return [];
      const { key, members } = entry.value;
      return [{ key, members: members.flatMap((member) => Option.toArray(decodeRef(member))) }];
    }),
  };
}
