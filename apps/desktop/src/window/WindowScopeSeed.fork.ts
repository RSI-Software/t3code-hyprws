/**
 * A new window's starting sidebar scope, passed as a preload argument. Electron
 * replays it on every reload, so the renderer applies it only while the window
 * has no scope of its own; `"all-projects"` opts out of inheriting the last
 * scope. No package imports, so the sandboxed preload can use it.
 */
const WINDOW_SCOPE_SEED_PRELOAD_ARGUMENT = "--t3code-window-scope-seed";

const ALL_PROJECTS = "all-projects";

export type WindowScopeSeed =
  | { readonly environmentId: string; readonly projectId: string }
  | typeof ALL_PROJECTS;

export function windowScopeSeedPreloadArgument(seed: WindowScopeSeed): string {
  // An encoded project pair always carries a "/", so it never reads as ALL_PROJECTS.
  const value =
    seed === ALL_PROJECTS
      ? ALL_PROJECTS
      : `${encodeURIComponent(seed.environmentId)}/${encodeURIComponent(seed.projectId)}`;
  return `${WINDOW_SCOPE_SEED_PRELOAD_ARGUMENT}=${value}`;
}

export function readWindowScopeSeedPreloadArgument(
  argv: readonly string[],
): WindowScopeSeed | null {
  const prefix = `${WINDOW_SCOPE_SEED_PRELOAD_ARGUMENT}=`;
  for (const argument of argv) {
    if (!argument.startsWith(prefix)) continue;
    if (argument === `${prefix}${ALL_PROJECTS}`) return ALL_PROJECTS;
    const parts = argument.slice(prefix.length).split("/");
    if (parts.length !== 2) continue;
    try {
      const [environmentId, projectId] = parts.map(decodeURIComponent);
      if (environmentId && projectId) return { environmentId, projectId };
    } catch {
      continue;
    }
  }
  return null;
}
