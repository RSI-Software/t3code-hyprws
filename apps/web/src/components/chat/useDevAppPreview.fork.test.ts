import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  armDevAppPreviewHandoff,
  DevAppPreviewHandoffCancelledError,
  DevAppPreviewInvocationLifecycle,
} from "../../browser/devAppPreviewHandoff";
import { openUrlInPreview } from "../../browser/openFileInPreview";
import { isPreviewSupportedInRuntime } from "../../previewStateStore";
import { readPreparedConnection } from "../../state/session";
import { projectScriptTerminalInput } from "@t3tools/shared/projectScripts";
import {
  createDevAppPreviewActionsFork,
  type DevAppPreviewScopeFork,
} from "./useDevAppPreview.fork";

vi.mock("../../browser/devAppPreviewHandoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../browser/devAppPreviewHandoff")>()),
  armDevAppPreviewHandoff: vi.fn(),
}));
vi.mock("../../state/session", () => ({ readPreparedConnection: vi.fn() }));
vi.mock("../../previewStateStore", () => ({ isPreviewSupportedInRuntime: vi.fn() }));
vi.mock("../../browser/openFileInPreview", () => ({ openUrlInPreview: vi.fn() }));

function setup() {
  vi.mocked(readPreparedConnection).mockReturnValue(null);
  vi.mocked(isPreviewSupportedInRuntime).mockReturnValue(true);
  vi.mocked(openUrlInPreview).mockResolvedValue(AsyncResult.success(undefined));
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const handoff = { ready, cancel: vi.fn(), isActive: vi.fn(() => true) };
  vi.mocked(armDevAppPreviewHandoff).mockReset().mockReturnValue(handoff);
  const scope: DevAppPreviewScopeFork = {
    lifecycle: new DevAppPreviewInvocationLifecycle(),
    handoffs: new Set(),
  };
  const threadRef = {
    environmentId: EnvironmentId.make("local"),
    threadId: ThreadId.make("thread"),
  };
  const onError = vi.fn();
  const actions = createDevAppPreviewActionsFork({
    getScope: () => scope,
    threadRef,
    openPreview: vi.fn(),
    onError,
  });
  const write = vi.fn(async () => AsyncResult.success(undefined));
  return { actions, scope, threadRef, onError, write, handoff, resolveReady, rejectReady };
}

const command = "vp run dev:app --preview";

describe("dev app script invocation", () => {
  it("passes the active project to the launcher without dropping script environment", () => {
    const { actions } = setup();
    expect(
      actions.launchEnvironment({ CUSTOM: "value", T3CODE_PROJECT_ID: "stale" }, "project"),
    ).toEqual({
      extraEnv: { CUSTOM: "value", T3CODE_PROJECT_ID: "project" },
    });
  });

  it("leaves ordinary script writes to the upstream runner", async () => {
    const { actions, scope, write } = setup();
    expect(
      await actions.write("vp run test", "terminal-2", scope.lifecycle.begin(), write, false),
    ).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(armDevAppPreviewHandoff).not.toHaveBeenCalled();
  });
  it("rejects a disconnected dev action without blocking ordinary scripts", () => {
    const { actions, onError } = setup();
    expect(actions.begin(command)).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("still connecting"));
    expect(actions.begin("vp run test")?.isActive()).toBe(true);
  });

  it("waits for attachment before writing and opens the emitted URL in the source thread", async () => {
    const { actions, scope, threadRef, write, handoff, resolveReady } = setup();
    const invocation = scope.lifecycle.begin();
    const result = actions.write(command, "terminal-2", invocation, write, false);
    expect(write).not.toHaveBeenCalled();
    expect(armDevAppPreviewHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: threadRef.environmentId,
        terminal: { threadId: threadRef.threadId, terminalId: "terminal-2" },
      }),
    );
    resolveReady();
    expect(await result).toBe(true);
    expect(write).toHaveBeenCalledWith("terminal-2", projectScriptTerminalInput(command));
    expect(handoff.cancel).not.toHaveBeenCalled();
    const url = "http://localhost:4312/pair#token=fresh";
    await vi.mocked(armDevAppPreviewHandoff).mock.calls[0]![0].onPreviewUrl(url);
    expect(openUrlInPreview).toHaveBeenCalledWith(expect.objectContaining({ threadRef, url }));
    expect(scope.handoffs.size).toBe(0);
  });

  it("does not write after the source thread leaves during attachment", async () => {
    const { actions, scope, write, handoff, resolveReady } = setup();
    const result = actions.write(command, "terminal-2", scope.lifecycle.begin(), write, false);
    scope.lifecycle.dispose();
    resolveReady();
    await result;
    expect(write).not.toHaveBeenCalled();
    expect(handoff.cancel).toHaveBeenCalledOnce();
    expect(scope.handoffs.size).toBe(0);
  });

  it("does not write or report an error when attachment is cancelled", async () => {
    const { actions, scope, write, onError, rejectReady } = setup();
    const result = actions.write(command, "terminal-2", scope.lifecycle.begin(), write, false);
    rejectReady(new DevAppPreviewHandoffCancelledError());
    await result;
    expect(write).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(scope.handoffs.size).toBe(0);
  });

  it("cancels the handoff if terminal write access disappears", async () => {
    const { actions, scope, handoff, resolveReady } = setup();
    const result = actions.write(command, "terminal-2", scope.lifecycle.begin(), () => null, false);
    resolveReady();
    await result;
    expect(handoff.cancel).toHaveBeenCalledOnce();
    expect(scope.handoffs.size).toBe(0);
  });

  it("uses external mode and preserves history when no embedded preview exists", async () => {
    const { actions, scope, write } = setup();
    vi.mocked(isPreviewSupportedInRuntime).mockReturnValue(false);
    await actions.write(command, "terminal-2", scope.lifecycle.begin(), write, true);
    expect(write).toHaveBeenCalledWith("terminal-2", "vp run dev:app --external\r");
    expect(armDevAppPreviewHandoff).not.toHaveBeenCalled();
  });
});
