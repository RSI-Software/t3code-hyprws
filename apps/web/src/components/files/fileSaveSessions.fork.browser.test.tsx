import { render, fakeTimers } from "../../../test/render";
import { EnvironmentId, ProjectWriteFileError, projectFileRevision } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom, AsyncResult } from "effect/reactivity";
import { StrictMode, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile, toast } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  confirmFile: vi.fn(),
  toast: vi.fn(),
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  sessionHasScope: () => true,
  environmentSession: { sessionStateAtom: () => Atom.make(null) } as never,
}));
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((...args: unknown[]) => writeFile(args[2])) as never,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  confirmProjectFileQueryData: confirmFile,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  clearProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  optimisticFileAtom,
  setProjectFileQueryData,
} from "./projectFilesQueryState";
import { changeFileSaveSession, useFileSaveSession } from "./fileSaveSessions";

const environmentId = EnvironmentId.make("stale-write-guard");
const onPendingChange = vi.fn();
const props = { environmentId, cwd: "/workspace", relativePath: "file.txt", onPendingChange };
const diskChanged = AsyncResult.failure(
  Cause.fail(
    new ProjectWriteFileError({
      cwd: props.cwd,
      relativePath: props.relativePath,
      failure: "contents_changed",
    }),
  ),
);

function setup() {
  writeFile.mockReset().mockResolvedValue(diskChanged);
  confirmFile.mockReset();
  onPendingChange.mockReset();
  toast.mockReset().mockReturnValue("conflict-toast");
}

/** The panel shows `contents` as read from disk, with no unsaved draft. */
function showLoadedFile(contents: string) {
  const atom = optimisticFileAtom(environmentId, props.cwd, props.relativePath);
  const unmount = appAtomRegistry.mount(atom);
  appAtomRegistry.set(atom, {
    confirmedAgainst: null,
    data: {
      relativePath: props.relativePath,
      contents,
      byteLength: contents.length,
      truncated: false,
    },
  });
  return {
    [Symbol.dispose]: () => {
      clearProjectFileQueryData(environmentId, props.cwd, props.relativePath);
      unmount();
    },
  };
}

/** Mounts an editor for the file without editing it. */
async function openEditor() {
  let change: (contents: string) => void = () => {};
  function FileSurface() {
    useFileSaveSession(props, onPendingChange);
    useEffect(() => {
      change = (contents) => changeFileSaveSession(props, contents);
    });
    return null;
  }
  const screen = await render(
    <StrictMode>
      <FileSurface />
    </StrictMode>,
    { router: false },
  );
  const edit = (contents: string) => {
    setProjectFileQueryData(environmentId, props.cwd, props.relativePath, contents);
    change(contents);
  };
  return Object.assign(screen, { edit });
}

/** Mounts an editor and edits the loaded file to `edited`. */
async function editLoadedFile(edited: string) {
  const screen = await openEditor();
  screen.edit(edited);
  return screen;
}

describe("file-save stale-write guard", () => {
  it("asks before a save replaces a newer disk version, then overwrites on request", async () => {
    setup();
    using _loaded = showLoadedFile("# Readme\n");
    using _timers = fakeTimers();
    await using _screen = await editLoadedFile("# Readme edited\n");
    await vi.advanceTimersByTimeAsync(500);

    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "file.txt",
        contents: "# Readme edited\n",
        expectedRevision: projectFileRevision("# Readme\n"),
      },
    });
    expect(toast).toHaveBeenCalledOnce();
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);

    writeFile.mockResolvedValue(AsyncResult.success({ relativePath: "file.txt" }));
    toast.mock.calls[0]![0].actionProps.onClick();
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "# Readme edited\n" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("drops the draft without writing it when the user reloads from disk", async () => {
    setup();
    using _loaded = showLoadedFile("# Readme\n");
    using _timers = fakeTimers();
    await using screen = await editLoadedFile("# Readme edited\n");
    await vi.advanceTimersByTimeAsync(500);

    toast.mock.calls[0]![0].data.secondaryActionProps.onClick();
    await screen.unmount();
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledOnce();
    expect(getOptimisticProjectFileQueryData(environmentId, "/workspace", "file.txt")).toBeNull();
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("drops the draft of a panel reopened since the prompt when the user reloads", async () => {
    setup();
    using _loaded = showLoadedFile("# Readme\n");
    using _timers = fakeTimers();
    await using first = await editLoadedFile("# Readme edited\n");
    await vi.advanceTimersByTimeAsync(500);
    await first.unmount();
    await using _reopened = await editLoadedFile("# Readme edited\n");
    const refusedSaves = writeFile.mock.calls.length;

    toast.mock.calls[0]![0].data.secondaryActionProps.onClick();
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(refusedSaves);
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("does not resave a draft another editor already saved", async () => {
    setup();
    const actual = await vi.importActual<typeof import("./projectFilesQueryState")>(
      "./projectFilesQueryState",
    );
    confirmFile.mockImplementation(actual.confirmProjectFileQueryData);
    using _loaded = showLoadedFile("# Readme\n");
    using _timers = fakeTimers();
    const inFlight = Promise.withResolvers<AsyncResult.AsyncResult<unknown, unknown>>();
    writeFile.mockReturnValueOnce(inFlight.promise);
    await using _first = await editLoadedFile("# Readme edited\n");
    await vi.advanceTimersByTimeAsync(500);
    // A second editor recovers the same unsaved draft while the first saves it.
    await using _second = await openEditor();

    inFlight.resolve(AsyncResult.success({ relativePath: "file.txt" }));
    await vi.advanceTimersByTimeAsync(0);
    // The readback after the save clears the draft before the replay fires.
    appAtomRegistry.set(optimisticFileAtom(environmentId, props.cwd, props.relativePath), null);
    // Only as far as the replay: the real readback leaves its own timers running.
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("keeps a closed panel's draft dropped when its in-flight save lands after Reload", async () => {
    setup();
    using _loaded = showLoadedFile("# Readme\n");
    using _timers = fakeTimers();
    await using screen = await editLoadedFile("# Readme edited\n");
    await vi.advanceTimersByTimeAsync(500);
    const inFlight = Promise.withResolvers<AsyncResult.AsyncResult<unknown, unknown>>();
    writeFile.mockReturnValueOnce(inFlight.promise);
    screen.edit("# Readme edited twice\n");
    await vi.advanceTimersByTimeAsync(500);
    screen.edit("# Readme edited thrice\n");
    await screen.unmount();

    toast.mock.calls[0]![0].data.secondaryActionProps.onClick();
    inFlight.resolve(AsyncResult.success({ relativePath: "file.txt" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile.mock.calls.map(([request]) => request.input.contents)).toEqual([
      "# Readme edited\n",
      "# Readme edited twice\n",
    ]);
  });

  it("drops a closed panel's in-flight draft when the user reloads and edits again", async () => {
    setup();
    using _loaded = showLoadedFile("# Readme\n");
    using _timers = fakeTimers();
    await using screen = await editLoadedFile("# Readme edited\n");
    await vi.advanceTimersByTimeAsync(500);
    const inFlight = Promise.withResolvers<typeof diskChanged>();
    writeFile.mockReturnValueOnce(inFlight.promise);
    screen.edit("# Readme edited twice\n");
    await vi.advanceTimersByTimeAsync(500);
    screen.edit("# Readme edited thrice\n");
    await screen.unmount();

    toast.mock.calls[0]![0].data.secondaryActionProps.onClick();
    await using _reopened = await editLoadedFile("# Readme fresh\n");
    inFlight.resolve(diskChanged);
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request.input.contents)).toEqual([
      "# Readme edited\n",
      "# Readme edited twice\n",
      "# Readme fresh\n",
    ]);
  });
});
