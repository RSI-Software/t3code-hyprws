import {
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalBufferState,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, type TerminalAttachInput } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createDevAppPreviewHandoffManager,
  DevAppPreviewLineDecoder,
  DevAppPreviewHandoffCancelledError,
  DevAppPreviewInvocationLifecycle,
  DevAppPreviewOutputWatcher,
  devAppPreviewActionCommandForRuntime,
  type DevAppPreviewHandoffSource,
  isDevAppPreviewActionCommand,
  parseDevAppPreviewLine,
} from "./devAppPreviewHandoff";

const previewUrl = "http://localhost:4312/pair#token=fresh-token";

function terminal(threadId: string, terminalId = "terminal-1"): TerminalAttachInput {
  return { threadId, terminalId };
}

function fakeHandoffSource() {
  type Result = AsyncResult.AsyncResult<TerminalBufferState, unknown>;
  const channels = new Map<
    string,
    { current: Result; listeners: Set<(result: Result) => void>; unsubscribeCount: number }
  >();
  const key = (environmentId: EnvironmentId, input: TerminalAttachInput) =>
    JSON.stringify([environmentId, input.threadId, input.terminalId]);
  const channel = (environmentId: EnvironmentId, input: TerminalAttachInput) => {
    const channelKey = key(environmentId, input);
    let value = channels.get(channelKey);
    if (!value) {
      value = {
        current: AsyncResult.success(EMPTY_TERMINAL_BUFFER_STATE),
        listeners: new Set(),
        unsubscribeCount: 0,
      };
      channels.set(channelKey, value);
    }
    return value;
  };
  const source: DevAppPreviewHandoffSource = {
    attach: ({ environmentId, terminal: input }) => {
      const value = channel(environmentId, input);
      return {
        get: () => value.current,
        subscribe: (listener) => {
          value.listeners.add(listener);
          return () => {
            if (value.listeners.delete(listener)) value.unsubscribeCount += 1;
          };
        },
      };
    },
  };
  return {
    source,
    emit: (
      environmentId: EnvironmentId,
      input: TerminalAttachInput,
      state: TerminalBufferState,
    ) => {
      const value = channel(environmentId, input);
      value.current = AsyncResult.success(state);
      for (const listener of value.listeners) listener(value.current);
    },
    channel,
  };
}

function withOutput(
  state: TerminalBufferState,
  output: TerminalBufferState["output"],
  status: TerminalBufferState["status"] = "running",
): TerminalBufferState {
  return { ...state, output, status, version: state.version + 1 };
}

function outputState(data: string, resetVersion: number): TerminalOutputState {
  return {
    generation: 1,
    chunks: data.length === 0 ? [] : [{ startOffset: 0, data, byteLength: data.length }],
    retainedBytes: data.length,
    resetVersion,
    nextOffset: data.length,
  };
}

describe("dev app preview handoff", () => {
  it("invalidates an invocation waiting across an async scope boundary", async () => {
    const lifecycle = new DevAppPreviewInvocationLifecycle();
    const invocation = lifecycle.begin();
    let continueInvocation!: () => void;
    const gate = new Promise<void>((resolve) => {
      continueInvocation = resolve;
    });
    const continued = gate.then(() => invocation.isActive());

    lifecycle.dispose();
    continueInvocation();

    await expect(continued).resolves.toBe(false);
  });

  it("cancels one invocation lease without invalidating its scoped peers", () => {
    const lifecycle = new DevAppPreviewInvocationLifecycle();
    const first = lifecycle.begin();
    const second = lifecycle.begin();
    first.cancel();

    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);
  });

  it("uses a fresh lifecycle after StrictMode cleanup and setup", () => {
    const firstSetup = new DevAppPreviewInvocationLifecycle();
    const firstSetupInvocation = firstSetup.begin();
    firstSetup.dispose();
    const secondSetup = new DevAppPreviewInvocationLifecycle();
    const secondSetupInvocation = secondSetup.begin();

    expect(firstSetupInvocation.isActive()).toBe(false);
    expect(secondSetupInvocation.isActive()).toBe(true);
  });

  it("keeps concurrent handoffs isolated by environment, thread, and terminal", async () => {
    const fake = fakeHandoffSource();
    const manager = createDevAppPreviewHandoffManager(fake.source);
    const environmentA = EnvironmentId.make("environment-a");
    const environmentB = EnvironmentId.make("environment-b");
    const targets = [
      { environmentId: environmentA, terminal: terminal("thread-a", "terminal-1"), label: "a" },
      { environmentId: environmentB, terminal: terminal("thread-a", "terminal-1"), label: "b" },
      { environmentId: environmentA, terminal: terminal("thread-b", "terminal-1"), label: "c" },
      { environmentId: environmentA, terminal: terminal("thread-a", "terminal-2"), label: "d" },
    ] as const;
    const opened: string[] = [];
    const handoffs = targets.map((target) =>
      manager.arm({
        environmentId: target.environmentId,
        terminal: target.terminal,
        onPreviewUrl: (url) => {
          opened.push(`${target.label}:${url}`);
        },
        onError: () => {},
      }),
    );
    for (const target of targets) {
      fake.emit(
        target.environmentId,
        target.terminal,
        withOutput(EMPTY_TERMINAL_BUFFER_STATE, outputState("", 1)),
      );
    }
    await Promise.all(handoffs.map((handoff) => handoff.ready));

    for (const target of targets) {
      fake.emit(
        target.environmentId,
        target.terminal,
        withOutput(
          EMPTY_TERMINAL_BUFFER_STATE,
          outputState(`[dev-app] previewUrl=${previewUrl}\n`, 1),
        ),
      );
    }
    expect(opened).toEqual(targets.map((target) => `${target.label}:${previewUrl}`));
  });

  it("replaces only a handoff for the same scoped terminal", async () => {
    const fake = fakeHandoffSource();
    const manager = createDevAppPreviewHandoffManager(fake.source);
    const environmentId = EnvironmentId.make("environment-a");
    const input = terminal("thread-a");
    const first = manager.arm({
      environmentId,
      terminal: input,
      onPreviewUrl: () => {},
      onError: () => {},
    });
    const firstReadiness = expect(first.ready).rejects.toBeInstanceOf(
      DevAppPreviewHandoffCancelledError,
    );
    const second = manager.arm({
      environmentId,
      terminal: input,
      onPreviewUrl: () => {},
      onError: () => {},
    });
    await firstReadiness;
    expect(fake.channel(environmentId, input).listeners.size).toBe(1);

    fake.emit(environmentId, input, withOutput(EMPTY_TERMINAL_BUFFER_STATE, outputState("", 1)));
    await second.ready;
    second.cancel();
    expect(fake.channel(environmentId, input).listeners.size).toBe(0);
  });

  it("cancels an invocation before readiness and ignores later output", async () => {
    const fake = fakeHandoffSource();
    const manager = createDevAppPreviewHandoffManager(fake.source);
    const environmentId = EnvironmentId.make("environment-a");
    const input = terminal("thread-a");
    const opened: string[] = [];
    const handoff = manager.arm({
      environmentId,
      terminal: input,
      onPreviewUrl: (url) => {
        opened.push(url);
      },
      onError: () => {},
    });
    const readiness = expect(handoff.ready).rejects.toBeInstanceOf(
      DevAppPreviewHandoffCancelledError,
    );
    handoff.cancel();
    await readiness;

    fake.emit(
      environmentId,
      input,
      withOutput(
        EMPTY_TERMINAL_BUFFER_STATE,
        outputState(`[dev-app] previewUrl=${previewUrl}\n`, 1),
      ),
    );
    expect(opened).toEqual([]);
    expect(fake.channel(environmentId, input).listeners.size).toBe(0);
  });

  it("cancels a ready invocation before late terminal output", async () => {
    const fake = fakeHandoffSource();
    const manager = createDevAppPreviewHandoffManager(fake.source);
    const environmentId = EnvironmentId.make("environment-a");
    const input = terminal("thread-a");
    const opened: string[] = [];
    const handoff = manager.arm({
      environmentId,
      terminal: input,
      onPreviewUrl: (url) => {
        opened.push(url);
      },
      onError: () => {},
    });
    const continuationSeesActiveHandoff = handoff.ready.then(() => handoff.isActive());
    fake.emit(environmentId, input, withOutput(EMPTY_TERMINAL_BUFFER_STATE, outputState("", 1)));
    handoff.cancel();
    await expect(continuationSeesActiveHandoff).resolves.toBe(false);

    fake.emit(
      environmentId,
      input,
      withOutput(
        EMPTY_TERMINAL_BUFFER_STATE,
        outputState(`[dev-app] previewUrl=${previewUrl}\n`, 1),
      ),
    );
    expect(opened).toEqual([]);
    expect(fake.channel(environmentId, input).listeners.size).toBe(0);
  });

  it("only arms the explicit dev:app preview project command", () => {
    expect(isDevAppPreviewActionCommand("vp run dev:app --preview")).toBe(true);
    expect(isDevAppPreviewActionCommand("vp run dev:app --share --preview")).toBe(true);
    expect(isDevAppPreviewActionCommand("vp run dev:app")).toBe(false);
    expect(isDevAppPreviewActionCommand("echo vp run dev:app --preview")).toBe(false);
    expect(isDevAppPreviewActionCommand("vp run dev:app --preview && echo owned")).toBe(false);
    expect(isDevAppPreviewActionCommand("vp run dev:app --preview --external")).toBe(false);
  });

  it("uses the external lane when the runtime cannot open a preview", () => {
    expect(devAppPreviewActionCommandForRuntime("vp run dev:app --preview", false)).toBe(
      "vp run dev:app --external",
    );
    expect(devAppPreviewActionCommandForRuntime("vp run dev:app --share --preview", false)).toBe(
      "vp run dev:app --share --external",
    );
    expect(devAppPreviewActionCommandForRuntime("vp run dev:app --preview", true)).toBe(
      "vp run dev:app --preview",
    );
    expect(devAppPreviewActionCommandForRuntime("vp run dev:app --desktop", false)).toBe(
      "vp run dev:app --desktop",
    );
  });

  it("accepts only local pairing URLs with one token fragment", () => {
    expect(parseDevAppPreviewLine(`[dev-app] previewUrl=${previewUrl}`)).toBe(previewUrl);
    expect(
      parseDevAppPreviewLine("[dev-app] previewUrl=http://127.0.0.1:4312/pair#token=fresh"),
    ).toBe("http://127.0.0.1:4312/pair#token=fresh");
    expect(
      parseDevAppPreviewLine("[dev-app] previewUrl=https://localhost:4312/pair#token=x"),
    ).toBeNull();
    expect(
      parseDevAppPreviewLine("[dev-app] previewUrl=http://evil.test:4312/pair#token=x"),
    ).toBeNull();
    expect(
      parseDevAppPreviewLine("[dev-app] previewUrl=http://localhost:4312/#token=x"),
    ).toBeNull();
    expect(parseDevAppPreviewLine("[dev-app] previewUrl=http://localhost:4312/pair")).toBeNull();
    expect(
      parseDevAppPreviewLine("[dev-app] previewUrl=http://localhost:0/pair#token=x"),
    ).toBeNull();
  });

  it("decodes a split line and recovers after unrelated bounded output", () => {
    const decoder = new DevAppPreviewLineDecoder();
    expect(decoder.push("x".repeat(5_000))).toBeNull();
    expect(decoder.push(`\r[dev-app] previewUrl=http://local`)).toBeNull();
    expect(decoder.push("host:4312/pair#token=fresh-token\r\n")).toBe(previewUrl);
    expect(decoder.push(`[dev-app] previewUrl=${previewUrl}\n`)).toBe(previewUrl);
  });

  it("strips split terminal controls from a managed tmux repaint", () => {
    const decoder = new DevAppPreviewLineDecoder();
    expect(
      decoder.push("old screen\u001b[2;1H\u001b[32m[dev-app] previewUrl=http://local"),
    ).toBeNull();
    expect(decoder.push("\u001b[0mhost:4312/pair#token=fresh-token\u001b]0;title")).toBeNull();
    expect(decoder.push("\u0007\r")).toBe(previewUrl);
  });

  it("ignores pre-action history and consumes output added after attachment", () => {
    const oldUrl = "http://localhost:4111/pair#token=old-token";
    const history = `before\n[dev-app] previewUrl=${oldUrl}\n`;
    const watcher = new DevAppPreviewOutputWatcher();
    let state = withOutput(EMPTY_TERMINAL_BUFFER_STATE, outputState(history, 1));
    expect(watcher.observe(state)).toEqual({ type: "ready" });

    const nextOutput = `${history}[dev-app] previewUrl=${previewUrl}\n`;
    state = withOutput(state, outputState(nextOutput, 1));
    expect(watcher.observe(state)).toEqual({ type: "preview", url: previewUrl });
  });

  it("waits through the empty attach seed and reports terminal exit", () => {
    const watcher = new DevAppPreviewOutputWatcher();
    expect(watcher.observe(EMPTY_TERMINAL_BUFFER_STATE)).toEqual({ type: "waiting" });
    expect(
      watcher.observe({
        ...EMPTY_TERMINAL_BUFFER_STATE,
        output: outputState("", 1),
        status: "exited",
        version: 1,
      }),
    ).toEqual({
      type: "ended",
      message: "The terminal exited before dev:app produced a preview URL.",
    });
  });

  it("finds new output retained by a managed attachment reset", () => {
    const history = "existing shell history\n";
    const watcher = new DevAppPreviewOutputWatcher();
    let state = withOutput(EMPTY_TERMINAL_BUFFER_STATE, outputState(history, 1));
    expect(watcher.observe(state)).toEqual({ type: "ready" });

    state = withOutput(state, outputState(`${history}[dev-app] previewUrl=${previewUrl}\n`, 2));
    expect(watcher.observe(state)).toEqual({ type: "preview", url: previewUrl });
  });

  it("does not trust an unrelated reset when prior history cannot be identified", () => {
    const watcher = new DevAppPreviewOutputWatcher();
    let state = withOutput(EMPTY_TERMINAL_BUFFER_STATE, outputState("known history\n", 1));
    expect(watcher.observe(state)).toEqual({ type: "ready" });

    state = withOutput(state, outputState(`[dev-app] previewUrl=${previewUrl}\n`, 2));
    expect(watcher.observe(state)).toEqual({ type: "waiting" });
  });
});
