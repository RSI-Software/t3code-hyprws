import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  EMPTY_TERMINAL_BUFFER_STATE,
  nextTerminalAttachSeedState,
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

  it("keeps the retained buffer while a re-keyed stream reports its uninitialized seed", () => {
    const live = updateRetainedTerminalAttachment(
      EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE,
      "terminal",
      buffer(7, "pre-move scrollback"),
      null,
    );
    // A checkout move re-keys the attach query on the launch identity; before
    // the recreated stream's first snapshot the query reports the
    // uninitialized seed. That seed must not displace the retained buffer, or
    // the viewport reads a phantom "closed" and closes the drawer.
    const rekeyed = updateRetainedTerminalAttachment(
      live,
      "terminal",
      nextTerminalAttachSeedState(),
      null,
    );
    expect(rekeyed).toBe(live);
    expect(terminalOutputText(rekeyed.value.output)).toBe("pre-move scrollback");
    expect(rekeyed.value.status).toBe("running");

    // The recreated stream's first real snapshot replaces the buffer and
    // keeps the public version monotonic.
    const ready = updateRetainedTerminalAttachment(
      rekeyed,
      "terminal",
      buffer(1, "fresh session"),
      null,
    );
    expect(terminalOutputText(ready.value.output)).toBe("fresh session");
    expect(ready.value.version).toBe(8);
  });

  it("ignores the seed after an identity change until a real snapshot arrives", () => {
    const changed = updateRetainedTerminalAttachment(
      EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE,
      "env-a/thread-a/terminal-b",
      nextTerminalAttachSeedState(),
      null,
    );
    expect(changed.value).toBe(EMPTY_TERMINAL_BUFFER_STATE);

    const ready = updateRetainedTerminalAttachment(
      changed,
      "env-a/thread-a/terminal-b",
      buffer(2, "hello"),
      null,
    );
    expect(terminalOutputText(ready.value.output)).toBe("hello");
    expect(ready.value.version).toBe(2);
  });
});
