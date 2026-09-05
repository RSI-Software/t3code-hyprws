import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  EMPTY_TERMINAL_BUFFER_STATE,
  terminalOutputText,
} from "@t3tools/client-runtime/state/terminal";
import {
  EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE,
  terminalAttachmentIdentity,
  updateRetainedTerminalAttachment,
} from "./terminalAttachmentRetention.fork";

const buffer = (version: number, value: string) => {
  const byteLength = new TextEncoder().encode(value).byteLength;
  return {
    ...EMPTY_TERMINAL_BUFFER_STATE,
    output: {
      ...EMPTY_TERMINAL_BUFFER_STATE.output,
      chunks: value.length === 0 ? [] : [{ startOffset: 0, data: value, byteLength }],
      retainedBytes: byteLength,
      nextOffset: value.length,
    },
    status: "running" as const,
    version,
  };
};

describe("retained terminal attachments", () => {
  it("separates identical thread and split IDs across environments", () => {
    const terminal = { threadId: ThreadId.make("thread"), terminalId: "split" };
    const first = terminalAttachmentIdentity({
      environmentId: EnvironmentId.make("env-a"),
      terminal,
    });
    const other = terminalAttachmentIdentity({
      environmentId: EnvironmentId.make("env-b"),
      terminal,
    });
    expect(other).not.toBe(first);
    expect(terminalAttachmentIdentity({ environmentId: null, terminal })).toBeNull();
    expect(
      terminalAttachmentIdentity({ environmentId: EnvironmentId.make("env-a"), terminal: null }),
    ).toBeNull();
  });

  it("retains one bounded buffer without appending or mutating earlier snapshots", () => {
    const source = buffer(4, "bounded output");
    const first = updateRetainedTerminalAttachment(
      EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE,
      "terminal",
      source,
      null,
    );
    const hidden = updateRetainedTerminalAttachment(first, "terminal", null, null);
    expect(hidden).toBe(first);
    expect(hidden.value.output).toBe(source.output);
    const resumed = updateRetainedTerminalAttachment(
      hidden,
      "terminal",
      buffer(1, "resumed"),
      null,
    );
    expect(terminalOutputText(first.value.output)).toBe("bounded output");
    expect(terminalOutputText(resumed.value.output)).toBe("resumed");
    expect(source.version).toBe(4);
  });

  it("clears a prior attach failure when a new stream supplies data", () => {
    const failed = updateRetainedTerminalAttachment(
      EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE,
      "terminal",
      null,
      "attach failed",
    );
    const resumed = updateRetainedTerminalAttachment(failed, "terminal", buffer(1, "ready"), null);
    expect(resumed.error).toBeNull();
    expect(updateRetainedTerminalAttachment(resumed, null, null, null)).toBe(
      EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE,
    );
  });
  it("resets scrollback when the terminal identity changes", () => {
    const first = updateRetainedTerminalAttachment(
      EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE,
      "env-a/thread-a/terminal-a",
      buffer(4, "terminal-a"),
      null,
    );
    const changed = updateRetainedTerminalAttachment(
      first,
      "env-a/thread-a/terminal-b",
      null,
      null,
    );

    expect(changed.value).toBe(EMPTY_TERMINAL_BUFFER_STATE);
    expect(terminalOutputText(changed.value.output)).toBe("");
  });

  it("keeps versions monotonic when a recreated attach stream restarts at version one", () => {
    const firstSource = buffer(8, "before hide");
    const first = updateRetainedTerminalAttachment(
      EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE,
      "terminal",
      firstSource,
      null,
    );
    const reattached = updateRetainedTerminalAttachment(
      first,
      "terminal",
      buffer(1, "after reattach"),
      null,
    );

    expect(first.value.version).toBe(8);
    expect(terminalOutputText(reattached.value.output)).toBe("after reattach");
    expect(reattached.value.version).toBe(9);
  });

  it("retains an attach error while the demand-gated stream is hidden", () => {
    const failed = updateRetainedTerminalAttachment(
      EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE,
      "terminal",
      null,
      "Exact zmux target could not be attached.",
    );
    const hidden = updateRetainedTerminalAttachment(failed, "terminal", null, null);

    expect(hidden.error).toBe("Exact zmux target could not be attached.");
  });
});
