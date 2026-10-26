import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { withStaleWriteGuard } from "./fileSaveConflict.fork";
import type { FileSaveCoordinator } from "./fileSaveCoordinator";
import type { FileSaveTarget } from "./fileSaveSessions";

export function guardFileSaveSessionFork(
  target: FileSaveTarget,
  current: () => FileSaveCoordinator | null,
) {
  const persist = withStaleWriteGuard(
    (request) => runAtomCommand(appAtomRegistry, projectEnvironment.writeFile, request),
    {
      get current() {
        return current();
      },
    },
  );
  return {
    persist: (contents: string) =>
      persist({
        environmentId: target.environmentId,
        input: { cwd: target.cwd, relativePath: target.relativePath, contents },
      }),
  };
}

export function resumeFileSaveSessionFork(
  session: { leases: number; flushingOnRelease: boolean } | undefined,
): void {
  if (session && session.leases > 0) session.flushingOnRelease = false;
}
