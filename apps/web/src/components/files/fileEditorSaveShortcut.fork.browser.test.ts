import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  installFileEditorSaveShortcutFork,
  isFileEditorSaveShortcutFork,
} from "./fileEditorSaveShortcut.fork";

it.each(["Rich root", "Source shadow root", "outside editor"])("Ctrl+S in %s", (mode) => {
  const container = document.body.appendChild(document.createElement("div"));
  const surface = container.appendChild(document.createElement("div"));
  const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
  const coordinator = new FileSaveCoordinator({
    debounceMs: 500,
    persist,
    onConfirmed: vi.fn(),
    onPendingChange: vi.fn(),
  });
  const uninstall = installFileEditorSaveShortcutFork(surface, () => coordinator.flush());
  const outside = mode === "outside editor";
  const target =
    mode === "Source shadow root"
      ? surface.attachShadow({ mode: "open" }).appendChild(document.createElement("textarea"))
      : outside
        ? container
        : surface;
  const stash = vi.fn();
  const capture = (event: KeyboardEvent) => {
    if (!isFileEditorSaveShortcutFork(event)) stash();
  };
  window.addEventListener("keydown", capture, true);
  try {
    coordinator.change("pending edit");
    const event = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(!outside);
    expect(stash).toHaveBeenCalledTimes(outside ? 1 : 0);
    expect(persist.mock.calls).toEqual(outside ? [] : [["pending edit"]]);
  } finally {
    window.removeEventListener("keydown", capture, true);
    uninstall();
    coordinator.dispose();
    container.remove();
  }
});
