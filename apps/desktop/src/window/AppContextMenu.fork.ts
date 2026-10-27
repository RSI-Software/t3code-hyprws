import type * as Electron from "electron";

const EDITING_ROLES = new Set(["cut", "copy", "paste", "selectAll"]);

/**
 * App menus render in the renderer, so in the app renderer a native menu opens
 * only for native actions the click offers; guests and sign-in popups keep the
 * native editing roles. Trims `template` in place; false when nothing is left.
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
