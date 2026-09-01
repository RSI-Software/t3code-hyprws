import { describe, expect, it } from "vite-plus/test";

import { EMPTY_TERMINAL_BUFFER_STATE } from "@t3tools/client-runtime/state/terminal";
import {
  EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE,
  updateRetainedTerminalAttachment,
} from "./terminalSessions";

const buffer = (version: number, value: string) => ({
  ...EMPTY_TERMINAL_BUFFER_STATE,
  buffer: value,
  status: "running" as const,
  version,
});

describe("retained terminal attachments", () => {
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
    expect(changed.value.buffer).toBe("");
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
    expect(reattached.value).toMatchObject({ buffer: "after reattach", version: 9 });
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
