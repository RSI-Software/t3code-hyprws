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

it("retains each terminal's mode choice through layout reconciliation and drops closed choices", () => {
  const store = useTerminalUiStateStore.getState();
  store.newTerminal(thread, "plain", "shell");
  store.newTerminal(thread, "managed", "zmux");
  store.newTerminal(thread, "default");
  store.reconcileTerminalIds(thread, ["default", "plain", "managed"]);
  expect(read().sessionModeByTerminalId).toEqual({ plain: "shell", managed: "zmux" });
  store.setTerminalOpen(thread, false);
  store.setTerminalOpen(thread, true);
  expect(read().sessionModeByTerminalId).toEqual({ plain: "shell", managed: "zmux" });
  store.closeTerminal(thread, "plain");
  expect(read().sessionModeByTerminalId).toEqual({ managed: "zmux" });
  store.newTerminal(thread, "plain");
  expect(read().sessionModeByTerminalId).toEqual({ managed: "zmux" });
  store.closeTerminal(thread, "managed");
  expect(read().sessionModeByTerminalId ?? {}).toEqual({});
});

it("persists a panel mode choice without adding a drawer terminal or opening it", async () => {
  const store = useTerminalUiStateStore.getState();
  store.newTerminal(thread, "drawer", "shell");
  store.setTerminalOpen(thread, false);
  store.setTerminalSessionModeFork(thread, "panel", "zmux");
  expect(read().terminalIds).toEqual(["drawer"]);
  expect(read().terminalOpen).toBe(false);
  store.closeTerminal(thread, "drawer");
  expect(read().sessionModeByTerminalId).toEqual({ panel: "zmux" });
  const { storage, name } = useTerminalUiStateStore.persist.getOptions();
  const saved = await storage!.getItem(name!);
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
  await storage!.setItem(name!, saved!);
  await useTerminalUiStateStore.persist.rehydrate();
  expect(read().sessionModeByTerminalId).toEqual({ panel: "zmux" });
  expect(read().terminalIds).toEqual([]);
  store.closeTerminal(thread, "panel");
  expect(read().sessionModeByTerminalId ?? {}).toEqual({});
});

it("rehydrates legacy plain-shell flags as shell modes without overriding newer modes", async () => {
  const store = useTerminalUiStateStore.getState();
  store.newTerminal(thread, "legacy");
  store.newTerminal(thread, "managed", "zmux");
  const { storage, name } = useTerminalUiStateStore.persist.getOptions();
  const saved = (await storage!.getItem(name!)) as {
    state: { terminalUiStateByThreadKey: Record<string, Record<string, unknown>> };
  };
  for (const threadState of Object.values(saved.state.terminalUiStateByThreadKey)) {
    threadState.plainShellByTerminalId = { legacy: true, managed: true };
  }
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
  await storage!.setItem(name!, saved as never);
  await useTerminalUiStateStore.persist.rehydrate();
  expect(read().sessionModeByTerminalId).toEqual({ legacy: "shell", managed: "zmux" });
  expect(read()).not.toHaveProperty("plainShellByTerminalId");
});
