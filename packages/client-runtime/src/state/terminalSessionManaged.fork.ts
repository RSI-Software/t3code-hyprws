import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t3tools/contracts";

import type { TerminalBufferState, TerminalGrid } from "./terminalSession.ts";

export function snapshotStatus(snapshot: TerminalSessionSnapshot) {
  return snapshot.status === "running" && snapshot.attachmentStatus === "suspended"
    ? { status: "suspended" as const }
    : {};
}

export function activityState(
  current: TerminalBufferState,
  event: Extract<TerminalAttachStreamEvent, { type: "activity" }>,
  grid: TerminalGrid | null,
): TerminalBufferState | undefined {
  if (event.attachmentStatus === undefined) return undefined;
  return {
    ...current,
    grid,
    status: event.attachmentStatus === "suspended" ? "suspended" : "running",
    error: null,
    version: current.version + 1,
  };
}
