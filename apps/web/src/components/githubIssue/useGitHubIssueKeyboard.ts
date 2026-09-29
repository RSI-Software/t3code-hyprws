import { useAtomValue } from "@effect/atom-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
} from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { resolveShortcutCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { toastManager } from "../ui/toast";
import { gitHubIssueListFocusStep, type GitHubIssueListFocus } from "./githubIssueKeyboard.logic";

const ROW_OPEN_SELECTOR = "[data-row-open]";

/** The page has no terminal, preview or model picker, so only focus and platform vary. */
function getShortcutContext() {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

function copyIssueLink(url: string) {
  void writeTextToClipboard(url, "issue link").then(
    (didCopy) => {
      if (didCopy)
        toastManager.add({ type: "success", title: "Issue link copied", description: url });
    },
    (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy issue link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  );
}

/**
 * The issue list's keyboard, matching the pull request page where the two share a gesture.
 *
 * The returned handler goes on an element holding both the search field and the rows, and walks
 * focus between them with the arrow keys; Enter on a row already opens it. With `page` set, the
 * page also answers the shortcuts ChatView would own elsewhere: Mod+F focuses the search, the
 * right panel's close shortcut closes the open issue and the copy-reference shortcut copies its
 * link. A thread's issues panel leaves those to the thread around it.
 */
export function useGitHubIssueKeyboard({
  page,
  searchRef,
  openIssueUrl,
  onCloseIssue,
}: {
  readonly page: boolean;
  /** Wraps the search field; its input is where Mod+F and ArrowUp off the first row land. */
  readonly searchRef: RefObject<HTMLElement | null>;
  /** The open issue's link, or null while none is open or it has not loaded. */
  readonly openIssueUrl: string | null;
  /** Closes the open issue, or null while none is open. */
  readonly onCloseIssue: (() => void) | null;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const onPageShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || isCommandPaletteOpen()) return;
    if (
      event.key.toLowerCase() === "f" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      const input = searchRef.current?.querySelector("input");
      input?.focus();
      input?.select();
      return;
    }
    const command = resolveShortcutCommand(event, keybindings, { context: getShortcutContext() });
    if (command === "rightPanel.close" && onCloseIssue !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) onCloseIssue();
    }
    if (command === "thread.copyReference" && openIssueUrl !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) copyIssueLink(openIssueUrl);
    }
  });
  useEffect(() => {
    if (!page) return;
    const onKeyDown = (event: KeyboardEvent) => onPageShortcut(event);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [page]);

  return useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement;
      const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ROW_OPEN_SELECTOR));
      const from: GitHubIssueListFocus | null = searchRef.current?.contains(target)
        ? "search"
        : target.matches(ROW_OPEN_SELECTOR)
          ? rows.indexOf(target)
          : null;
      if (from === null || from === -1) return;
      const to = gitHubIssueListFocusStep(event.key, from, rows.length);
      if (to === null) return;
      event.preventDefault();
      if (to === "search") {
        searchRef.current?.querySelector("input")?.focus();
        return;
      }
      rows[to]?.scrollIntoView({ block: "nearest" });
      rows[to]?.focus({ preventScroll: true });
    },
    [searchRef],
  );
}
