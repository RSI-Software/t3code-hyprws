import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_TERMINAL_ID } from "@t3tools/contracts";

import { getTerminalLabel } from "@t3tools/shared/terminalLabels";

import {
  buildTerminalMenuSessions,
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

describe("buildTerminalMenuSessions", () => {
  it("keeps the current terminal visible even if it is no longer running", () => {
    expect(
      buildTerminalMenuSessions({
        knownSessions: [],
        workspaceRoot: "/workspace/root",
        currentSession: {
          terminalId: "term-4",
          cwd: "/workspace/exited",
          status: "exited",
          hasRunningSubprocess: false,
          displayLabel: "Terminal 4",
          updatedAt: "2026-04-15T20:07:00.000Z",
        },
      }),
    ).toEqual([
      {
        terminalId: "term-4",
        cwd: "/workspace/exited",
        status: "exited",
        hasRunningSubprocess: false,
        displayLabel: "Terminal 4",
        updatedAt: "2026-04-15T20:07:00.000Z",
      },
    ]);
  });
});

describe("nextOpenTerminalId", () => {
  it("allocates separate terminals on repeated visits without readable metadata", () => {
    const first = nextOpenTerminalId({
      listedTerminalIds: [],
      uniqueSuffix: "783c91cc-a413-47c7-8312-c2a5a1f05e40",
    });
    const nextVisit = nextOpenTerminalId({
      listedTerminalIds: [],
      uniqueSuffix: "102315fc-ceef-45c4-b978-c4d4947d3c26",
    });
    expect(first).not.toBe(DEFAULT_TERMINAL_ID);
    expect(nextVisit).not.toBe(first);
  });

  it("matches nextTerminalId when not on a terminal route", () => {
    expect(nextOpenTerminalId({ listedTerminalIds: [] })).toBe(DEFAULT_TERMINAL_ID);
    expect(nextOpenTerminalId({ listedTerminalIds: [DEFAULT_TERMINAL_ID] })).toBe("term-2");
  });

  it("avoids the mounted primary tab when the session list is still empty", () => {
    expect(
      nextOpenTerminalId({
        listedTerminalIds: [],
        activeRouteTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-2");
  });

  it("does not double-count when the route id is already listed", () => {
    expect(
      nextOpenTerminalId({
        listedTerminalIds: [DEFAULT_TERMINAL_ID],
        activeRouteTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-2");
  });
});

describe("previousLiveTerminalId", () => {
  it("returns null when no other live session remains", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: "term-2", status: "exited" }),
          makeMenuSession({ terminalId: "term-3", status: "closed" }),
        ],
        exitedTerminalId: "term-2",
      }),
    ).toBe(null);
  });

  it("prefers the nearest live session below the exited id", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "running" }),
          makeMenuSession({ terminalId: "term-2", status: "running" }),
          makeMenuSession({ terminalId: "term-3", status: "exited" }),
          makeMenuSession({ terminalId: "term-4", status: "running" }),
        ],
        exitedTerminalId: "term-3",
      }),
    ).toBe("term-2");
  });

  it("falls back to the nearest live session above when the exited id was lowest", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "exited" }),
          makeMenuSession({ terminalId: "term-2", status: "starting" }),
          makeMenuSession({ terminalId: "term-4", status: "running" }),
        ],
        exitedTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-2");
  });

  it("ignores dead sessions when picking the fallback", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "running" }),
          makeMenuSession({ terminalId: "term-2", status: "exited" }),
          makeMenuSession({ terminalId: "term-3", status: "exited" }),
        ],
        exitedTerminalId: "term-3",
      }),
    ).toBe(DEFAULT_TERMINAL_ID);
  });
});

describe("resolveProjectScriptTerminalId", () => {
  it("never targets an unseen default terminal when metadata is unavailable", () => {
    const terminalId = resolveProjectScriptTerminalId({
      existingTerminalIds: [],
      hasRunningTerminal: false,
      uniqueSuffix: "783c91cc-a413-47c7-8312-c2a5a1f05e40",
    });
    expect(terminalId).not.toBe(DEFAULT_TERMINAL_ID);
    expect(getTerminalLabel(terminalId)).toBe("Terminal 1");
  });

  it("reuses the default shell when no terminal is running", () => {
    expect(
      resolveProjectScriptTerminalId({
        existingTerminalIds: [DEFAULT_TERMINAL_ID],
        hasRunningTerminal: false,
      }),
    ).toBe(DEFAULT_TERMINAL_ID);
  });

  it("opens a new terminal when a shell is already running", () => {
    expect(
      resolveProjectScriptTerminalId({
        existingTerminalIds: [DEFAULT_TERMINAL_ID, "term-2", "term-4"],
        hasRunningTerminal: true,
      }),
    ).toBe("term-3");
  });
});
