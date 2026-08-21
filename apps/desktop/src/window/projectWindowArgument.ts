/**
 * Project-window preload argument, kept free of package imports so the
 * sandboxed preload can use it. A preload bundle that pulls in `@t3tools/*`
 * leaves a runtime `require()` behind and fails to load, which drops the whole
 * desktop bridge.
 */
export const PROJECT_WINDOW_PRELOAD_ARGUMENT = "--t3code-project-window";

export type ProjectWindowArgumentParts = {
  readonly environmentId: string;
  readonly projectId: string;
};

export function isProjectWindowPreload(argv: readonly string[]): boolean {
  return argv.some(
    (argument) =>
      argument === PROJECT_WINDOW_PRELOAD_ARGUMENT ||
      argument.startsWith(`${PROJECT_WINDOW_PRELOAD_ARGUMENT}=`),
  );
}

/**
 * Renderer-visible marker for a project window. The value rides along so the
 * web client can tell which project owns the window once the route leaves the
 * project subtree (settings pages are shared with the hub).
 */
export function projectWindowPreloadArgument(ref: ProjectWindowArgumentParts): string {
  return `${PROJECT_WINDOW_PRELOAD_ARGUMENT}=${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.projectId)}`;
}

export function readProjectWindowPreloadParts(
  argv: readonly string[],
): ProjectWindowArgumentParts | null {
  const prefix = `${PROJECT_WINDOW_PRELOAD_ARGUMENT}=`;
  for (const argument of argv) {
    if (!argument.startsWith(prefix)) continue;
    const [environmentId, projectId] = argument.slice(prefix.length).split("/");
    if (environmentId === undefined || projectId === undefined) continue;
    try {
      const decodedEnvironmentId = decodeURIComponent(environmentId);
      const decodedProjectId = decodeURIComponent(projectId);
      if (decodedEnvironmentId.length === 0 || decodedProjectId.length === 0) continue;
      return { environmentId: decodedEnvironmentId, projectId: decodedProjectId };
    } catch {
      continue;
    }
  }
  return null;
}
