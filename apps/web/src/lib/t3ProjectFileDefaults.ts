import { T3_PROJECT_FILE_NAME, type EnvironmentId, type ThreadEnvMode } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * How long the new-thread path waits for the project file before falling back
 * to the global default. The query never settles while the environment is
 * unreachable, and a draft is client-side state that must not wait on the
 * network: without this bound, opening a project whose environment is down
 * leaves the route stuck with nothing rendered.
 */
const PROJECT_FILE_DEFAULTS_TIMEOUT_MS = 2000;

/**
 * Read `defaultThreadEnvMode` from the project's checked-in `t3.json`.
 *
 * Imperative counterpart to `useT3ProjectFileScripts` for the new-thread
 * path, which resolves defaults at call time rather than render time. The
 * file query atom caches per (environment, cwd), so repeat calls don't
 * re-fetch. Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, invalid, and unreachable
 * files all resolve to null.
 */
export async function readT3ProjectFileDefaultThreadEnvMode(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  timeoutMs: number = PROJECT_FILE_DEFAULTS_TIMEOUT_MS,
): Promise<ThreadEnvMode | null> {
  const result = await withTimeout(
    executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
      { reportDefect: false, reportFailure: false },
    ),
    timeoutMs,
  );
  if (result === null) return null;
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseT3ProjectFile(data.contents)?.defaultThreadEnvMode ?? null;
}

async function withTimeout<A>(promise: Promise<A>, timeoutMs: number): Promise<A | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
