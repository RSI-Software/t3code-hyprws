import type * as Electron from "electron";

const EDITING_ROLES = new Set(["cut", "copy", "paste", "selectAll"]);

/**
 * App action menus stay in the renderer so they keep T3's icons, hierarchy,
 * and theme tokens; inside the app's own renderer a native menu opens only for
 * the native actions this click actually offers. A browser guest or a sign-in
 * popup has no renderer menu behind it, so it keeps the always-native editing
 * roles. Trims `template` in place; false when nothing is left to show.
 */
export const trimAppContextMenuFork = (
  template: Electron.MenuItemConstructorOptions[],
  params: Electron.ContextMenuParams,
  isAppRenderer: boolean,
): boolean => {
  if (isAppRenderer && !params.isEditable && (params.selectionText?.length ?? 0) === 0) {
    for (let index = template.length - 1; index >= 0; index -= 1) {
      const role = template[index]?.role;
      if (role !== undefined && EDITING_ROLES.has(role)) template.splice(index, 1);
    }
  }
  if (template.at(-1)?.type === "separator") template.pop();
  return template.length > 0;
};
