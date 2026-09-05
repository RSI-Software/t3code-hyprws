import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, TerminalSessionSnapshot, ThreadId } from "@t3tools/contracts";
import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  terminalOutputText,
} from "./terminalSession.ts";
const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
  terminalId: "term-1",
} as const;
const BASE_SNAPSHOT: TerminalSessionSnapshot = {
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "hello",
  exitCode: null,
  exitSignal: null,
  label: "Terminal 1",
  updatedAt: "2026-04-01T00:00:00.000Z",
};
describe("terminal session reducers", () => {
  it("updates and removes one viewer without replacing another viewer's metadata", () => {
    const viewerA = {
      threadId: BASE_SNAPSHOT.threadId,
      terminalId: BASE_SNAPSHOT.terminalId,
      attachmentId: "viewer-a:term-1",
      cwd: "/repo/a",
      worktreePath: "/repo/a",
      status: "running" as const,
      pid: 123,
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-04-01T00:00:00.000Z",
      hasRunningSubprocess: false,
      label: "Viewer A",
    };
    const viewerB = {
      ...viewerA,
      attachmentId: "viewer-b:term-1",
      cwd: "/repo/b",
      worktreePath: "/repo/b",
      pid: 456,
      label: "Viewer B",
    };
    const initial = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [viewerA, viewerB],
    });
    const updated = applyTerminalMetadataStreamEvent(initial, {
      type: "upsert",
      terminal: { ...viewerA, cwd: "/repo/a-next", worktreePath: "/repo/a-next" },
    });
    const removed = applyTerminalMetadataStreamEvent(updated, {
      type: "remove",
      threadId: viewerA.threadId,
      terminalId: viewerA.terminalId,
      attachmentId: viewerA.attachmentId,
    });

    expect(updated).toHaveLength(2);
    expect(updated.find((terminal) => terminal.attachmentId === viewerA.attachmentId)?.cwd).toBe(
      "/repo/a-next",
    );
    expect(updated.find((terminal) => terminal.attachmentId === viewerB.attachmentId)).toEqual(
      viewerB,
    );
    expect(removed).toEqual([viewerB]);
  });

  it("preserves scrollback across managed suspension and replaces it from the resume snapshot", () => {
    const attached = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "before suspend" },
    });
    const suspended = applyTerminalAttachStreamEvent(attached, {
      type: "activity",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      hasRunningSubprocess: true,
      label: "zmux/main",
      attachmentStatus: "suspended",
    });
    const resumed = applyTerminalAttachStreamEvent(suspended, {
      type: "snapshot",
      snapshot: {
        ...BASE_SNAPSHOT,
        attachmentStatus: "attached",
        history: "before suspend\ncurrent tmux screen",
      },
    });
    expect(terminalOutputText(suspended.output)).toBe("before suspend");
    expect(suspended.status).toBe("suspended");
    expect(terminalOutputText(resumed.output)).toBe("before suspend\ncurrent tmux screen");
    expect(resumed).toMatchObject({ status: "running", version: 3 });
  });
  it("uses optional metadata attachment state when the attach stream is idle", () => {
    const retained = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const summary = {
      threadId: BASE_SNAPSHOT.threadId,
      terminalId: BASE_SNAPSHOT.terminalId,
      cwd: BASE_SNAPSHOT.cwd,
      worktreePath: BASE_SNAPSHOT.worktreePath,
      status: "running" as const,
      pid: null,
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-04-01T00:01:00.000Z",
      hasRunningSubprocess: true,
      label: "zmux/main",
      attachmentStatus: "suspended" as const,
    };
    expect(combineTerminalSessionState(summary, retained)).toMatchObject({
      status: "suspended",
      hasRunningSubprocess: true,
    });
  });
  it("monotonically advances snapshot versions on reattach", () => {
    const current = { ...EMPTY_TERMINAL_BUFFER_STATE, version: 7 };
    const reattached = applyTerminalAttachStreamEvent(current, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    expect(reattached.version).toBe(8);
  });
});
