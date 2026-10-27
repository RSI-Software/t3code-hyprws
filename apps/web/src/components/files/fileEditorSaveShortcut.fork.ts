import { useEffect, type RefObject } from "react";

const SAVE_SURFACE_ATTRIBUTE = "data-file-editor-save";

/** Composed paths also cover Source's editor inside its shadow root. */
export function isFileEditorSaveShortcutFork(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "s" &&
    event
      .composedPath()
      .some((node) => node instanceof Element && node.hasAttribute(SAVE_SURFACE_ATTRIBUTE))
  );
}

/** The composer's window capture listener yields to this editor-local handler. */
export function installFileEditorSaveShortcutFork(root: HTMLElement, save: () => void) {
  const handler = (event: KeyboardEvent) => {
    if (!isFileEditorSaveShortcutFork(event)) return;
    event.preventDefault();
    event.stopPropagation();
    save();
  };
  root.setAttribute(SAVE_SURFACE_ATTRIBUTE, "");
  root.addEventListener("keydown", handler, true);
  return () => {
    root.removeAttribute(SAVE_SURFACE_ATTRIBUTE);
    root.removeEventListener("keydown", handler, true);
  };
}

export function useFileEditorSaveShortcutFork(
  root: RefObject<HTMLElement | null>,
  save: () => void,
) {
  // oxlint-disable-next-line t3code/react-effect-budget -- installs a capture-phase keydown DOM listener on the editor root.
  useEffect(() => {
    if (root.current) return installFileEditorSaveShortcutFork(root.current, save);
  }, [root, save]);
}
