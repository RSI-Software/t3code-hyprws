import {
  AuthTerminalOperateScope,
  EnvironmentId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { nextTerminalAttachSeedState } from "@t3tools/client-runtime/state/terminal";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  GhosttyTerminalSurface,
  GhosttyTerminalSurfaceOptions,
} from "~/terminal/ghostty/surface";
import { terminalAttachmentId } from "../terminalAttachmentIdentity";
import { useTerminalUiStateStore } from "../terminalUiStateStore";

const state = vi.hoisted(() => ({
  allowed: true,
  listeners: new Set<() => void>(),
  resize: vi.fn(),
  open: vi.fn(),
  otherCommand: vi.fn(),
  createSurface:
    vi.fn<
      (
        mount: HTMLElement,
        options: GhosttyTerminalSurfaceOptions,
      ) => Promise<GhosttyTerminalSurface>
    >(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => null) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettings: ((select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS)) as never,
}));
vi.mock(import("../editorPreferences"), async (original) => ({
  ...(await original()),
  useOpenInPreferredEditor: (() => state.otherCommand) as never,
}));
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => null) as never,
}));
vi.mock(import("../state/terminal"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    terminalEnvironment: {
      ...actual.terminalEnvironment,
      resize: "resize" as never,
      open: "open" as never,
    },
  };
});
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === "resize"
      ? state.resize
      : command === "open"
        ? state.open
        : state.otherCommand) as never,
}));
vi.mock(import("../state/terminalSessions"), async (original) => ({
  ...(await original()),
  useAttachedTerminalSession: (() => session) as never,
}));
vi.mock(import("~/terminal/ghostty/surface"), async (original) => ({
  ...(await original()),
  GhosttyTerminalSurface: { create: state.createSurface } as never,
}));
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthTerminalOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    ...(await original()),
    readEnvironmentScope,
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});

import { TerminalViewport } from "./ThreadTerminalDrawer";

const threadRef = {
  environmentId: EnvironmentId.make("secondary-terminal"),
  threadId: ThreadId.make("thread"),
};
const session = { ...nextTerminalAttachSeedState(), status: "running" as const, version: 1 };
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  state.allowed = true;
  state.listeners.clear();
  state.resize.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.open.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.otherCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  // A surface can report its initial grid while asynchronous WASM setup is
  // pending. Keep that unrelated setup pending while exercising its callback.
  state.createSurface.mockReset().mockReturnValue(new Promise(() => undefined));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const splitTerminalIds = ["split-1", "split-2"];

function splitView(worktreePath: string | null, attached = true) {
  return (
    <>
      {splitTerminalIds.map((terminalId) => (
        <TerminalViewport
          key={terminalId}
          advancedTypography={false}
          threadRef={threadRef}
          threadId={threadRef.threadId}
          terminalId={terminalId}
          terminalLabel={terminalId}
          cwd={worktreePath ?? "/repo"}
          worktreePath={worktreePath}
          runtimeEnv={{ T3CODE_WORKTREE_PATH: worktreePath ?? "/repo" }}
          onSessionExited={state.otherCommand}
          focusRequestId={0}
          autoFocus={false}
          visible={attached}
          resizeEpoch={0}
          drawerHeight={200}
          keybindings={[]}
          attached={attached}
          restoreFocusOnReattach={false}
        />
      ))}
    </>
  );
}

it.each(["shell", "zmux"] as const)(
  "retargets a remounted hidden %s split after a move and Undo",
  async (mode) => {
    for (const terminalId of splitTerminalIds) {
      useTerminalUiStateStore.getState().setTerminalSessionModeFork(threadRef, terminalId, mode);
    }
    await act(async () => {
      root.render(splitView(null));
    });
    state.open.mockClear();

    // Selecting another group unmounts these viewports. The thread moves
    // while they are absent; attach alone reuses the old server sessions.
    for (const worktreePath of ["/repo-move", null]) {
      await act(async () => root.render(<></>));
      await act(async () => root.render(splitView(worktreePath)));
      expect(state.open).toHaveBeenCalledTimes(2);
      for (const terminalId of splitTerminalIds) {
        expect(state.open).toHaveBeenCalledWith({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            terminalId,
            attachmentId: terminalAttachmentId(terminalId),
            cwd: worktreePath ?? "/repo",
            worktreePath,
            env: { T3CODE_WORKTREE_PATH: worktreePath ?? "/repo" },
            sessionModeFork: mode,
          },
        });
      }
      // Ordinary rerenders must not reopen either PTY.
      await act(async () => root.render(splitView(worktreePath)));
      expect(state.open).toHaveBeenCalledTimes(2);
      state.open.mockClear();
    }
  },
);

it("defers an initial retarget until shown and never retargets a read-only viewer", async () => {
  await act(async () => {
    root.render(splitView("/repo-move", false));
  });
  expect(state.open).not.toHaveBeenCalled();
  await act(async () => root.render(splitView("/repo-move")));
  expect(state.open).toHaveBeenCalledTimes(2);

  await act(async () => root.render(<></>));
  state.open.mockClear();
  state.allowed = false;
  await act(async () => root.render(splitView(null)));
  expect(state.open).not.toHaveBeenCalled();
});

it("sends the attachment id with a resize that passes the target terminal grant recheck", async () => {
  await act(async () => {
    root.render(
      <TerminalViewport
        advancedTypography={false}
        threadRef={threadRef}
        threadId={threadRef.threadId}
        terminalId="terminal-1"
        terminalLabel="Terminal 1"
        cwd="/repo"
        onSessionExited={state.otherCommand}
        focusRequestId={0}
        autoFocus={false}
        visible={true}
        resizeEpoch={0}
        drawerHeight={200}
        keybindings={[]}
        attached
        restoreFocusOnReattach
      />,
    );
  });
  expect(state.createSurface).toHaveBeenCalledOnce();
  const onResize = state.createSurface.mock.calls[0]![1].onResize;
  if (!onResize) throw new Error("The terminal did not register its resize callback.");

  onResize(80, 24);
  expect(state.resize).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      terminalId: "terminal-1",
      attachmentId: terminalAttachmentId("terminal-1"),
      cols: 80,
      rows: 24,
    },
  });

  // The connection updates before React commits its external-store update.
  // Other environments retain access; only this terminal's target is revoked.
  state.allowed = false;
  onResize(120, 40);
  expect(state.resize).toHaveBeenCalledTimes(1);

  state.allowed = true;
  onResize(100, 30);
  expect(state.resize).toHaveBeenCalledTimes(2);
  expect(state.resize).toHaveBeenLastCalledWith({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      terminalId: "terminal-1",
      attachmentId: terminalAttachmentId("terminal-1"),
      cols: 100,
      rows: 30,
    },
  });
});
