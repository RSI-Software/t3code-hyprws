import { describe, expect, it } from "vite-plus/test";
import {
  type TerminalFocusGateStateFork,
  handleComposerFocusCommandFork,
  reduceTerminalFocusGateFork,
  shouldAutoFocusComposerOnThreadChange,
} from "./ChatView.focus.fork";

function element(
  tagName: string,
  options: { editable?: boolean; role?: string; within?: string } = {},
): Pick<Element, "tagName" | "closest" | "getAttribute"> & { isContentEditable?: boolean } {
  return {
    tagName,
    ...(options.editable === undefined ? {} : { isContentEditable: options.editable }),
    getAttribute: (name: string) => (name === "role" ? (options.role ?? null) : null),
    closest: () => (options.within !== undefined ? ({} as Element) : null),
  };
}

describe("shouldAutoFocusComposerOnThreadChange", () => {
  it("folds into upstream's window-focus predicate", () => {
    // The composer owns focus on thread change when nothing deliberate holds it.
    expect(shouldAutoFocusComposerOnThreadChange(null)).toBe(true);
    expect(shouldAutoFocusComposerOnThreadChange(element("BODY"))).toBe(true);
    expect(shouldAutoFocusComposerOnThreadChange(element("BUTTON"))).toBe(true);
  });

  it("yields to typing surfaces, drawer and panel terminals, and overlays", () => {
    expect(shouldAutoFocusComposerOnThreadChange(element("TEXTAREA"))).toBe(false);
    expect(shouldAutoFocusComposerOnThreadChange(element("DIV", { editable: true }))).toBe(false);
    expect(
      shouldAutoFocusComposerOnThreadChange(element("BUTTON", { within: "data-terminal-owner" })),
    ).toBe(false);
    expect(shouldAutoFocusComposerOnThreadChange(element("BUTTON", { within: "dialog" }))).toBe(
      false,
    );
  });
});

const IDLE: TerminalFocusGateStateFork = {
  threadKey: "thread-1",
  drawerRequestId: 0,
  panelRequestId: 0,
};

describe("reduceTerminalFocusGateFork", () => {
  it("routes a bump to the requesting pane only", () => {
    expect(
      reduceTerminalFocusGateFork(IDLE, { requestId: 3, threadKey: "thread-1", intent: "drawer" }),
    ).toEqual({ threadKey: "thread-1", drawerRequestId: 3, panelRequestId: 0 });
    expect(
      reduceTerminalFocusGateFork(
        { threadKey: "thread-1", drawerRequestId: 3, panelRequestId: 0 },
        { requestId: 4, threadKey: "thread-1", intent: "panel" },
      ),
    ).toEqual({ threadKey: "thread-1", drawerRequestId: 3, panelRequestId: 4 });
  });

  it("never lets one pane's request focus the other pane", () => {
    const after = reduceTerminalFocusGateFork(IDLE, {
      requestId: 2,
      threadKey: "thread-1",
      intent: "panel",
    });
    expect(after.drawerRequestId).toBe(0);
  });

  it("resets both panes when the active thread changes", () => {
    const held: TerminalFocusGateStateFork = {
      threadKey: "thread-1",
      drawerRequestId: 5,
      panelRequestId: 6,
    };
    expect(
      reduceTerminalFocusGateFork(held, { requestId: 5, threadKey: "thread-2", intent: null }),
    ).toEqual({ threadKey: "thread-2", drawerRequestId: 0, panelRequestId: 0 });
  });

  it("keeps requests while the thread is unchanged and no intent was recorded", () => {
    const held: TerminalFocusGateStateFork = {
      threadKey: "thread-1",
      drawerRequestId: 5,
      panelRequestId: 0,
    };
    expect(
      reduceTerminalFocusGateFork(held, { requestId: 5, threadKey: "thread-1", intent: null }),
    ).toBe(held);
  });

  it("never assigns the zero no-request sentinel", () => {
    expect(
      reduceTerminalFocusGateFork(IDLE, { requestId: 0, threadKey: "thread-1", intent: "drawer" }),
    ).toEqual(IDLE);
  });
});

function commandInput(overrides: Partial<Parameters<typeof handleComposerFocusCommandFork>[0]>) {
  return {
    command: "",
    event: {
      preventDefault: () => {},
      stopPropagation: () => {},
    },
    rightPanelMaximized: false,
    toggleRightPanelMaximized: () => {},
    drawerOpen: true,
    toggleDrawer: () => {},
    requestDrawerFocus: () => {},
    scheduleComposerFocus: () => {},
    focusComposer: () => {},
    ...overrides,
  };
}

describe("handleComposerFocusCommandFork", () => {
  it("terminal.focus opens the drawer when it is closed", () => {
    let opened = false;
    let focused = false;
    const consumed = handleComposerFocusCommandFork(
      commandInput({
        command: "terminal.focus",
        drawerOpen: false,
        toggleDrawer: () => {
          opened = true;
        },
        requestDrawerFocus: () => {
          focused = true;
        },
      }),
    );
    expect(consumed).toBe(true);
    expect(opened).toBe(true);
    expect(focused).toBe(false);
  });

  it("terminal.focus requests drawer focus when the drawer is already open", () => {
    let focused = false;
    const consumed = handleComposerFocusCommandFork(
      commandInput({
        command: "terminal.focus",
        requestDrawerFocus: () => {
          focused = true;
        },
      }),
    );
    expect(consumed).toBe(true);
    expect(focused).toBe(true);
  });

  it("terminal.focus leaves a maximized right panel first", () => {
    let maximized = false;
    handleComposerFocusCommandFork(
      commandInput({
        command: "terminal.focus",
        rightPanelMaximized: true,
        toggleRightPanelMaximized: () => {
          maximized = true;
        },
      }),
    );
    expect(maximized).toBe(true);
  });

  it("chat.focusComposer returns to the composer without closing the drawer", () => {
    let focused = false;
    let toggled = false;
    const consumed = handleComposerFocusCommandFork(
      commandInput({
        command: "chat.focusComposer",
        focusComposer: () => {
          focused = true;
        },
        toggleDrawer: () => {
          toggled = true;
        },
      }),
    );
    expect(consumed).toBe(true);
    expect(focused).toBe(true);
    expect(toggled).toBe(false);
  });

  it("chat.focusComposer under a maximized right panel schedules focus after restore", () => {
    let scheduled = false;
    let focusedDirectly = false;
    const consumed = handleComposerFocusCommandFork(
      commandInput({
        command: "chat.focusComposer",
        rightPanelMaximized: true,
        scheduleComposerFocus: () => {
          scheduled = true;
        },
        focusComposer: () => {
          focusedDirectly = true;
        },
      }),
    );
    expect(consumed).toBe(true);
    expect(scheduled).toBe(true);
    expect(focusedDirectly).toBe(false);
  });

  it("leaves unrelated commands alone", () => {
    expect(handleComposerFocusCommandFork(commandInput({ command: "terminal.toggle" }))).toBe(
      false,
    );
  });
});
