import type * as Electron from "electron";

/**
 * Fork-only: File → New Window (RSI-Software/t3code-hyprws#1343). No
 * accelerator: the renderer's `window.new` keybinding owns the chord, so a
 * user rebinding it is not shadowed and one press never opens two windows.
 */
export const newWindowMenuItems = (
  click: () => void,
): readonly Electron.MenuItemConstructorOptions[] => [
  { label: "New Window", click },
  { type: "separator" },
];
