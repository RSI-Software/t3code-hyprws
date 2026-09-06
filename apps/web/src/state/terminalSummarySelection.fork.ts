import type { TerminalAttachInput, TerminalSummary } from "@t3tools/contracts";

// Fork-owned exact-target lookup for the attached terminal session. Upstream
// resolves its summary through its own metadata indexing; this boundary keeps
// the fork's viewer-local attachment match (thread, terminal, attachment id)
// in one place so the upstream module carries only the call.
export function selectTerminalSummary(
  metadata: ReadonlyArray<TerminalSummary> | null,
  terminal: TerminalAttachInput | null,
): TerminalSummary | null {
  if (metadata === null || terminal === null) return null;
  return (
    metadata.find(
      (summary) =>
        summary.threadId === terminal.threadId &&
        summary.terminalId === terminal.terminalId &&
        (summary.attachmentId ?? null) === (terminal.attachmentId ?? null),
    ) ?? null
  );
}
