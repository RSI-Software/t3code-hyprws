import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "./terminalUiStateStore";
import { DEFAULT_THREAD_TERMINAL_ID } from "./types";
const THREAD_REF = scopeThreadRef("environment-a" as never, ThreadId.make("thread-1"));
describe("terminal checkout mode", () => {
  beforeEach(() => {
    useTerminalUiStateStore.persist.clearStorage();
    useTerminalUiStateStore.setState({
      terminalUiStateByThreadKey: {},
      suppressedTerminalIdsByThreadKey: {},
    });
  });
  it("follows by default and persists a pin per logical terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.setTerminalCheckoutMode(THREAD_REF, DEFAULT_THREAD_TERMINAL_ID, "pin");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).checkoutModeByTerminalId,
    ).toEqual({ [DEFAULT_THREAD_TERMINAL_ID]: "pin" });
    useTerminalUiStateStore
      .getState()
      .setTerminalCheckoutMode(THREAD_REF, DEFAULT_THREAD_TERMINAL_ID, "follow");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).checkoutModeByTerminalId,
    ).toEqual({});
  });
});
