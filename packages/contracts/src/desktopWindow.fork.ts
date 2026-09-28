import * as Schema from "effect/Schema";

import { ScopedProjectRef } from "./environment.ts";

/**
 * A hash route inside the app, such as `/` or `/env/thread`. Leading
 * `//` is refused so a route can never read as a protocol-relative URL.
 */
export const DesktopWindowRoute = Schema.String.check(Schema.isPattern(/^\/(?!\/)/u));

/**
 * Window requests a client may send to the desktop shell. `new-window` opens `/` showing every
 * project; `open-in-new-window` opens `route` with `seed` as its project filter; `project-link`
 * focuses a window showing `ref`, else creates one seeded with it; `focus` reveals that window
 * id, if still open. Second launches and OAuth callbacks never come from a client.
 */
export const DesktopWindowRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new-window") }),
  Schema.Struct({
    kind: Schema.Literal("open-in-new-window"),
    route: DesktopWindowRoute,
    seed: ScopedProjectRef,
  }),
  Schema.Struct({ kind: Schema.Literal("project-link"), ref: ScopedProjectRef }),
  Schema.Struct({ kind: Schema.Literal("focus"), windowId: Schema.String }),
]);
export type DesktopWindowRequest = typeof DesktopWindowRequest.Type;

/**
 * The request a window keybinding sends. `window.openProject` (`mod+alt+o`)
 * reuses the project's window like a deep link; null without a project.
 */
export function windowCommandRequest(
  command: "window.new" | "window.openProject",
  projectRef: ScopedProjectRef | null | undefined,
): DesktopWindowRequest | null {
  if (command === "window.new") return { kind: "new-window" };
  return projectRef ? { kind: "project-link", ref: projectRef } : null;
}
