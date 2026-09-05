import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_TERMINAL_ID,
  TerminalEvent,
  TerminalOpenInput,
  TerminalSessionSnapshot,
} from "./terminal.ts";
function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}
function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}
describe("TerminalSessionSnapshot", () => {
  const isoTimestamp = "2026-01-01T00:00:00.000Z";
  it("keeps managed suspension in an optional attachment field", () => {
    const snapshot = {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      worktreePath: null,
      status: "running" as const,
      pid: 1234,
      history: "hello\n",
      exitCode: null,
      exitSignal: null,
      label: "Primary",
      updatedAt: isoTimestamp,
    };
    expect(decodes(TerminalSessionSnapshot, snapshot)).toBe(true);
    expect(
      decodes(TerminalSessionSnapshot, {
        ...snapshot,
        pid: null,
        attachmentStatus: "suspended",
      }),
    ).toBe(true);
    expect(decodes(TerminalSessionSnapshot, { ...snapshot, status: "suspended" })).toBe(false);
  });
});
describe("viewer terminal identity", () => {
  it("keeps legacy shared terminals while accepting a viewer attachment identity", () => {
    expect(
      decodeSync(TerminalOpenInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
      }).attachmentId,
    ).toBeUndefined();
    expect(
      decodeSync(TerminalOpenInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        attachmentId: "device-a",
        cwd: "/tmp/project",
      }).attachmentId,
    ).toBe("device-a");
  });
  it("identifies output for one viewer attachment", () => {
    expect(
      decodeSync(TerminalEvent, {
        type: "output",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        attachmentId: "device-a",
        data: "line\n",
      }).attachmentId,
    ).toBe("device-a");
  });
});
describe("TerminalEvent", () => {
  it("announces managed suspension through the existing activity event", () => {
    const event = {
      type: "activity" as const,
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      hasRunningSubprocess: true,
      label: "zmux/main",
      attachmentStatus: "suspended" as const,
    };
    expect(decodes(TerminalEvent, event)).toBe(true);
    const legacyActivityEvent = Schema.Struct({
      type: Schema.Literal("activity"),
      threadId: Schema.String,
      terminalId: Schema.String,
      hasRunningSubprocess: Schema.Boolean,
      label: Schema.String,
    });
    expect(decodeSync(legacyActivityEvent, event)).toEqual({
      type: "activity",
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      hasRunningSubprocess: true,
      label: "zmux/main",
    });
  });
});
