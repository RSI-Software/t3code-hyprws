/**
 * The project a new window's sidebar scope starts on (RSI-Software/t3code-hyprws#1344).
 *
 * Main passes it as a preload argument to a window it creates for one project
 * (Open in New Window, a v1 restore entry), and the renderer applies it only
 * while that window has no scope of its own. Electron replays the argument on
 * every reload, so the renderer, not main, decides when a seed is spent.
 *
 * Without a seed a new window inherits the last scope any window chose, as
 * upstream does; `"all-projects"` opts a window out of that inheritance.
 *
 * Kept free of package imports so the sandboxed preload can use it; see
 * `WindowId.fork.ts` for why.
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
