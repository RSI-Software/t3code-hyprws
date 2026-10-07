import * as NodeModule from "node:module";
import { EMPTY_TERMINAL_BUFFER_STATE } from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useTerminalGridSync } from "./useTerminalGridSync";

const access = vi.hoisted(() => ({ environments: new Set<string>() }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === "terminal:operate" && access.environments.has(environmentId),
}));

// Mobile already depends on ReactDOM but does not install its browser type declarations.
const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): {
    render(children: ReactNode): void;
    unmount(): void;
  };
};

type Input = Parameters<typeof useTerminalGridSync>[0];
let root: ReturnType<typeof createRoot>;
const resize = vi.fn<Input["resize"]>();

function GridProbe(input: Input) {
  useTerminalGridSync(input);
  return null;
}

function session({
  generation = 1,
  version = 1,
  status = "running",
}: {
  readonly generation?: number;
  readonly version?: number;
  readonly status?: Input["terminal"]["status"];
} = {}): Input["terminal"] {
  return { output: { ...EMPTY_TERMINAL_BUFFER_STATE.output, generation }, version, status };
}

function input(): Input {
  return {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    terminalId: "term-1",
    canOperate: true,
    terminal: session(),
    size: { cols: 80, rows: 24 },
    resize,
  };
}

function render(value: Input) {
  return act(() => root.render(createElement(GridProbe, value)));
}

beforeEach(() => {
  resize.mockClear();
  access.environments.clear();
  access.environments.add("environment");
  // The probe renders no DOM, but ReactDOM needs an event target to run real effects.
  const document = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});

it("names the managed attachment on a replayed resize", async () => {
  const current = { ...input(), attachmentId: "attachment-1" };
  await render(current);
  expect(resize).toHaveBeenCalledExactlyOnceWith({
    environmentId: "environment",
    input: {
      threadId: "thread",
      terminalId: "term-1",
      attachmentId: "attachment-1",
      cols: 80,
      rows: 24,
    },
  });

  // Dropping the attachment changes the resize target, so the grid replays.
  await render({ ...current, attachmentId: null });
  expect(resize).toHaveBeenCalledTimes(2);
  expect(resize).toHaveBeenLastCalledWith({
    environmentId: "environment",
    input: { threadId: "thread", terminalId: "term-1", cols: 80, rows: 24 },
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
