// Fork-only (colleague-collab): a frozen share streams nothing, and the host keeps no messages
// for it, so a device that never opened the thread says it has no copy instead of loading forever.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { UnplugIcon } from "lucide-react";

import { useQuietThreadProjection, useThreadStatus } from "~/state/entities";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";

/**
 * A cached copy loads before the thread connects, so a frozen thread still connecting without
 * data has none here, and the host's lone `synchronized` brings none.
 */
export function useFrozenWithoutCopyFork(
  thread:
    | {
        readonly environmentId: EnvironmentId;
        readonly id: ThreadId;
        readonly collaboratorFork?: OrchestrationV2ThreadShell["collaboratorFork"];
      }
    | null
    | undefined,
): boolean {
  const ref =
    thread?.collaboratorFork === "frozen" ? scopeThreadRef(thread.environmentId, thread.id) : null;
  const status = useThreadStatus(ref);
  const projection = useQuietThreadProjection(ref);
  return ref !== null && status === "synchronizing" && projection === null;
}

export function FrozenNoCopyFork() {
  const gt = useGT();
  return (
    <Empty size="compact" data-frozen-no-copy-fork="true">
      <EmptyMedia variant="icon">
        <UnplugIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{gt("No copy on this device")}</EmptyTitle>
        <EmptyDescription>
          {gt(
            "The host stopped sharing this thread. A copy is kept only on devices that opened it before.",
          )}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
