import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { readThreadShell } from "../state/entities";

/** Change request links prefer the thread's project and borrow a host checkout outside the panel too. */
export function linkPreferenceFork(resolvedThreadRef: ScopedThreadRef | undefined): {
  readonly projectId?: ProjectId | undefined;
  readonly lendHostProject?: boolean;
} {
  const projectId = resolvedThreadRef ? readThreadShell(resolvedThreadRef)?.projectId : undefined;
  return { projectId, lendHostProject: true };
}
