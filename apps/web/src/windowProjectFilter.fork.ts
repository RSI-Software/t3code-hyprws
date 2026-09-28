// The sidebar's view of this window's project filter
// (RSI-Software/t3code-hyprws#1351). The filter itself lives with the
// per-window record in `windowSidebarScope.fork.ts`.
import {
  projectFilterProjectKeys,
  projectFilterScopeKey,
  reconcileProjectFilter,
} from "@t3tools/client-runtime/state/project-filter";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useAllEnvironmentProjectSnapshotsReady } from "./state/entities";
import { windowProjectFilterState } from "./windowSidebarScope.fork";

/**
 * Follows this window's filter onto the sidebar's current project groups and
 * projects it for upstream: `scopeKey` is the one entry's key, else `null`,
 * `projectKeys` the scoped project keys the list shows (`null` = all). The
 * chooser reads `filter` and writes through `setFilter`.
 */
export function useWindowProjectFilter(
  projectGroups: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
  }>,
) {
  const state = windowProjectFilterState();
  const stored = useSyncExternalStore(state.subscribe, state.get);
  const settled = useAllEnvironmentProjectSnapshotsReady();
  const groups = useMemo(
    () =>
      projectGroups.map((group) => ({ key: group.projectKey, members: group.memberProjectRefs })),
    [projectGroups],
  );
  const filter = useMemo(
    () => reconcileProjectFilter(stored, groups, settled),
    [groups, settled, stored],
  );
  useEffect(() => {
    if (filter !== stored) state.set(filter);
  }, [filter, state, stored]);
  return useMemo(
    () => ({
      filter,
      setFilter: state.set,
      scopeKey: projectFilterScopeKey(filter),
      projectKeys: projectFilterProjectKeys(filter),
    }),
    [filter, state],
  );
}
