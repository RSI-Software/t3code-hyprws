// This device's project filter (RSI-Software/t3code-hyprws#1351), kept as a
// device-local preference. The single-select chooser's picks write it, and the
// Home list's and the sidebar's selected project follow it.
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  ALL_PROJECTS_FILTER,
  projectFilterFromKey,
  projectFilterScopeKey,
  reconcileProjectFilter,
} from "@t3tools/client-runtime/state/project-filter";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useWorkspaceState } from "../../state/workspace";
import type { ResolvedHomeListOptions } from "./home-list-options";
import { buildHomeProjectScopes } from "./homeThreadList";

/**
 * Records a chooser pick: a project replaces the filter, `null` clears it. A
 * cleared filter of several entries leaves the selected key `null` as it was,
 * so the pick itself, not a key change, has to reach the preference.
 */
export function pickMobileProjectFilter(projectKey: string | null): void {
  appAtomRegistry.set(updateMobilePreferencesAtom, {
    projectFilter: projectFilterFromKey(projectKey),
  });
}

/**
 * Replaces upstream's `onProjectChange` when spread after it. Optional in type
 * only, so the spread may follow the prop it replaces.
 */
export const mobileProjectFilterPick: {
  readonly onProjectChange?: (projectKey: string | null) => void;
} = { onProjectChange: pickMobileProjectFilter };

/**
 * Keeps `selectedProjectKey` on the stored filter. The filter follows the device's project groups; an entry whose
 * environment is not connected yet stays stored, and shows again once back.
 */
export function useMobileProjectFilter(
  projects: ReadonlyArray<EnvironmentProject>,
  options: Pick<ResolvedHomeListOptions, "projectGroupingMode" | "selectedEnvironmentId">,
  selectedProjectKey: string | null,
  setSelectedProjectKey: (key: string | null) => void,
) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  const stored = (loaded && preferences.value.projectFilter) || ALL_PROJECTS_FILTER;
  const { environments, state } = useWorkspaceState();
  const settled =
    !state.isLoadingConnections &&
    state.hasLoadedShellSnapshot &&
    !state.hasPendingShellSnapshot &&
    environments.every((environment) => {
      return !environment.isEnabled || environment.connectionState === "connected";
    });
  const { projectGroupingMode, selectedEnvironmentId } = options;
  const groups = useMemo(
    () =>
      buildHomeProjectScopes({ projects, environmentId: null, projectGroupingMode }).map(
        (scope) => ({ key: scope.key, members: scope.projectRefs }),
      ),
    [projectGroupingMode, projects],
  );
  const filter = useMemo(
    () => reconcileProjectFilter(stored, groups, settled),
    [groups, settled, stored],
  );
  useEffect(() => {
    if (loaded && filter !== stored) savePreferences({ projectFilter: filter });
  }, [filter, loaded, savePreferences, stored]);

  // The chooser can only show a key its environment filter lists.
  const scopeKey = projectFilterScopeKey(filter);
  const exposedKey = useMemo(() => {
    if (scopeKey === null) return null;
    const visible = buildHomeProjectScopes({
      projects,
      environmentId: selectedEnvironmentId,
      projectGroupingMode,
    });
    return visible.some((scope) => scope.key === scopeKey) ? scopeKey : null;
  }, [projectGroupingMode, projects, scopeKey, selectedEnvironmentId]);

  const seenExposed = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || exposedKey === seenExposed.current) return;
    seenExposed.current = exposedKey;
    if (exposedKey !== selectedProjectKey) setSelectedProjectKey(exposedKey);
  }, [exposedKey, loaded, selectedProjectKey, setSelectedProjectKey]);
}
