import { describe, expect, it } from "vite-plus/test";
import type { TerminalAttachInput, TerminalSummary } from "@t3tools/contracts";

import { selectTerminalSummary } from "./terminalSummarySelection.fork";

function summary(overrides: Partial<TerminalSummary> = {}): TerminalSummary {
  return {
    threadId: "thread-a",
    terminalId: "terminal-1",
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 123,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    label: "Terminal",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

function terminal(overrides: Partial<TerminalAttachInput> = {}): TerminalAttachInput {
  return {
    threadId: "thread-a",
    terminalId: "terminal-1",
    ...overrides,
  };
}

describe("selectTerminalSummary", () => {
  it("matches the exact viewer-local attachment identity", () => {
    const viewerA = summary({ attachmentId: "viewer-a:terminal-1" });
    const viewerB = summary({ attachmentId: "viewer-b:terminal-1" });
    const metadata = [viewerA, viewerB];

    expect(selectTerminalSummary(metadata, terminal({ attachmentId: "viewer-b:terminal-1" }))).toBe(
      viewerB,
    );
    expect(selectTerminalSummary(metadata, terminal({ attachmentId: "viewer-a:terminal-1" }))).toBe(
      viewerA,
    );
  });

  it("treats a missing attachment id as the legacy shared terminal", () => {
    const shared = summary();
    const viewer = summary({ attachmentId: "viewer-a:terminal-1" });
    const metadata = [viewer, shared];

    expect(selectTerminalSummary(metadata, terminal())).toBe(shared);
    expect(selectTerminalSummary(metadata, terminal({ attachmentId: "viewer-a:terminal-1" }))).toBe(
      viewer,
    );
  });

  it("returns null without metadata, a terminal, or a matching summary", () => {
    const metadata = [summary({ terminalId: "terminal-2" })];

    expect(selectTerminalSummary(null, terminal())).toBeNull();
    expect(selectTerminalSummary(metadata, null)).toBeNull();
    expect(selectTerminalSummary(metadata, terminal())).toBeNull();
    expect(selectTerminalSummary([], terminal())).toBeNull();
  });
});
