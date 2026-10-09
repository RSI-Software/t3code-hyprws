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

const thread = scopeThreadRef("environment-a" as never, ThreadId.make("thread-plain"));
const read = () =>
  selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    thread,
  );

beforeEach(() => {
  useTerminalUiStateStore.persist.clearStorage();
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
});

it("retains plain-shell choice through layout reconciliation and drops closed choices", () => {
  const store = useTerminalUiStateStore.getState();
  store.newTerminal(thread, "plain", true);
  store.newTerminal(thread, "other-plain", true);
  store.newTerminal(thread, "managed");
  store.reconcileTerminalIds(thread, ["managed", "plain", "other-plain"]);
  expect(read().plainShellByTerminalId).toEqual({ plain: true, "other-plain": true });
  store.setTerminalOpen(thread, false);
  store.setTerminalOpen(thread, true);
  expect(read().plainShellByTerminalId).toEqual({ plain: true, "other-plain": true });
  store.closeTerminal(thread, "plain");
  expect(read().plainShellByTerminalId).toEqual({ "other-plain": true });
  store.newTerminal(thread, "plain");
  expect(read().plainShellByTerminalId).toEqual({ "other-plain": true });
  store.closeTerminal(thread, "other-plain");
  expect(read().plainShellByTerminalId ?? {}).toEqual({});
});

it("persists a panel shell choice without adding a drawer terminal or opening it", async () => {
  const store = useTerminalUiStateStore.getState();
  store.newTerminal(thread, "drawer", true);
  store.setTerminalOpen(thread, false);
  store.setTerminalPlainShellFork(thread, "panel");
  expect(read().terminalIds).toEqual(["drawer"]);
  expect(read().terminalOpen).toBe(false);
  store.closeTerminal(thread, "drawer");
  expect(read().plainShellByTerminalId).toEqual({ panel: true });
  const { storage, name } = useTerminalUiStateStore.persist.getOptions();
  const saved = await storage!.getItem(name!);
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
  await storage!.setItem(name!, saved!);
  await useTerminalUiStateStore.persist.rehydrate();
  expect(read().plainShellByTerminalId).toEqual({ panel: true });
  expect(read().terminalIds).toEqual([]);
  store.closeTerminal(thread, "panel");
  expect(read().plainShellByTerminalId ?? {}).toEqual({});
});
