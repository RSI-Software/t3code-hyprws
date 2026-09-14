import { describe, expect, it } from "vite-plus/test";
import {
  type TerminalFocusGateStateFork,
  reduceTerminalFocusGateFork,
  shouldAutoFocusComposerOnThreadChange,
  shouldAdvanceTerminalFocusGateFork,
} from "./ChatView.focus.fork";
import { shouldHandleTerminalFocusRequest } from "./ThreadTerminalDrawer.fork";

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

  it("a thread revisited after navigating away replays no pane request", () => {
    const held = reduceTerminalFocusGateFork(IDLE, {
      requestId: 5,
      threadKey: "thread-1",
      intent: "drawer",
    });
    const away = reduceTerminalFocusGateFork(held, {
      requestId: 5,
      threadKey: null,
      intent: null,
    });
    const back = reduceTerminalFocusGateFork(away, {
      requestId: 5,
      threadKey: "thread-1",
      intent: null,
    });
    expect(back.drawerRequestId).toBe(0);
    // The viewport gate rejects the zero sentinel, so the remounted drawer
    // never claims focus and the composer keeps it.
    expect(
      shouldHandleTerminalFocusRequest({
        focusOnRequest: true,
        focusRequestId: back.drawerRequestId,
        handledFocusRequestId: 0,
      }),
    ).toBe(false);
  });

  it("the gate advances on a thread-key move even without a request bump", () => {
    const held: TerminalFocusGateStateFork = {
      threadKey: "thread-1",
      drawerRequestId: 5,
      panelRequestId: 0,
    };
    expect(
      shouldAdvanceTerminalFocusGateFork(held, {
        requestId: 5,
        threadKey: "thread-2",
        lastSeenRequestId: 5,
      }),
    ).toBe(true);
    expect(
      shouldAdvanceTerminalFocusGateFork(held, {
        requestId: 5,
        threadKey: "thread-1",
        lastSeenRequestId: 5,
      }),
    ).toBe(false);
  });

  it("never assigns the zero no-request sentinel", () => {
    expect(
      reduceTerminalFocusGateFork(IDLE, { requestId: 0, threadKey: "thread-1", intent: "drawer" }),
    ).toEqual(IDLE);
  });
});
