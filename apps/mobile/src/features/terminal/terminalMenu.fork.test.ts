import { describe, expect, it } from "vite-plus/test";
import { type KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { DEFAULT_TERMINAL_ID, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  buildTerminalMenuSessions,
  getTerminalStatusLabel,
  nextOpenTerminalId,
  previousLiveTerminalId,
  resolveProjectScriptTerminalId,
  type TerminalMenuSession,
} from "./terminalMenu";
function makeMenuSession(input: {
  readonly terminalId: string;
  readonly status: TerminalMenuSession["status"];
}): TerminalMenuSession {
  return {
    terminalId: input.terminalId,
    cwd: null,
    status: input.status,
    hasRunningSubprocess: false,
    displayLabel: getTerminalLabel(input.terminalId),
    updatedAt: null,
  };
}
function makeKnownSession(input: {
  readonly terminalId: string;
  readonly status: KnownTerminalSession["state"]["status"];
  readonly cwd?: string | null;
  readonly updatedAt?: string | null;
}): KnownTerminalSession {
  return {
    target: {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: input.terminalId,
    },
    state: {
      summary: input.cwd
        ? {
            threadId: "thread-1",
            terminalId: input.terminalId,
            cwd: input.cwd,
            worktreePath: input.cwd,
            status:
              input.status === "closed"
                ? "error"
                : input.status === "suspended"
                  ? "running"
                  : input.status,
            pid: input.status === "running" ? 123 : null,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: getTerminalLabel(input.terminalId),
            updatedAt: input.updatedAt ?? "2026-04-15T20:00:00.000Z",
            ...(input.status === "suspended" ? { attachmentStatus: "suspended" as const } : {}),
          }
        : null,
      buffer: "",
      status: input.status,
      error: null,
      hasRunningSubprocess: false,
      updatedAt: input.updatedAt ?? "2026-04-15T20:00:00.000Z",
      version: 1,
    },
  };
}
describe("buildTerminalMenuSessions", () => {
  it("lists live and suspended server-known sessions (plus current)", () => {
    expect(
      buildTerminalMenuSessions({
        knownSessions: [
          makeKnownSession({
            terminalId: "term-3",
            status: "running",
            cwd: "/workspace/feature",
            updatedAt: "2026-04-15T20:05:00.000Z",
          }),
          makeKnownSession({
            terminalId: "term-2",
            status: "suspended",
            cwd: "/workspace/suspended",
            updatedAt: "2026-04-15T20:06:00.000Z",
          }),
        ],
        workspaceRoot: "/workspace/root",
      }),
    ).toEqual([
      {
        terminalId: "term-2",
        cwd: "/workspace/suspended",
        status: "suspended",
        hasRunningSubprocess: false,
        displayLabel: "Terminal 2",
        updatedAt: "2026-04-15T20:06:00.000Z",
      },
      {
        terminalId: "term-3",
        cwd: "/workspace/feature",
        status: "running",
        hasRunningSubprocess: false,
        displayLabel: "Terminal 3",
        updatedAt: "2026-04-15T20:05:00.000Z",
      },
    ]);
  });
  it("labels suspended managed attachments explicitly", () => {
    expect(getTerminalStatusLabel({ status: "suspended" })).toBe("Suspended");
  });
});
describe("previousLiveTerminalId", () => {
  it("treats a suspended managed attachment as a resumable live session", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "suspended" }),
          makeMenuSession({ terminalId: "term-2", status: "exited" }),
        ],
        exitedTerminalId: "term-2",
      }),
    ).toBe(DEFAULT_TERMINAL_ID);
  });
});
