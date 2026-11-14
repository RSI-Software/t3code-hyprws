import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";

export function themedDesktopContextMenuFork() {
  if (!window.desktopBridge) return {};
  return {
    contextMenu: {
      show: showContextMenuFallback,
      close: async () => dismissContextMenu(),
    },
  };
}
