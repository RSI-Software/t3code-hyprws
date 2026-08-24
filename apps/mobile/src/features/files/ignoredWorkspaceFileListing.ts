import { useAtomValue } from "@effect/atom-react";
import type { ProjectListEntriesInput } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";

/**
 * Keep the fork's ignored-file preference out of the shared mobile file routes.
 * An omitted flag preserves the upstream listing request and cache key.
 */
export function resolveIgnoredWorkspaceFileListing(
  cwd: string,
  showIgnoredFiles: boolean | undefined,
): ProjectListEntriesInput;
export function resolveIgnoredWorkspaceFileListing(
  cwd: string | null,
  showIgnoredFiles: boolean | undefined,
): ProjectListEntriesInput | null;
export function resolveIgnoredWorkspaceFileListing(
  cwd: string | null,
  showIgnoredFiles: boolean | undefined,
): ProjectListEntriesInput | null {
  if (cwd === null) return null;
  return showIgnoredFiles === true ? { cwd, includeIgnored: true } : { cwd };
}

export function useIgnoredWorkspaceFileListing(cwd: string): ProjectListEntriesInput;
export function useIgnoredWorkspaceFileListing(cwd: string | null): ProjectListEntriesInput | null;
export function useIgnoredWorkspaceFileListing(cwd: string | null): ProjectListEntriesInput | null {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return resolveIgnoredWorkspaceFileListing(
    cwd,
    AsyncResult.isSuccess(preferences) ? preferences.value.showIgnoredFiles : undefined,
  );
}
