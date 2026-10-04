import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId } from "./baseSchemas.ts";
import { ScopedProjectRef } from "./environment.ts";

/**
 * A hash route inside the app, such as `/` or `/env/thread`. Leading
 * `//` is refused so a route can never read as a protocol-relative URL.
 */
export const DesktopWindowRoute = Schema.String.check(Schema.isPattern(/^\/(?!\/)/u));

/**
 * The window requests a client may send to the desktop shell
 * (RSI-Software/t3code-hyprws#1343). The remaining launch requests (second
 * launch, OAuth callbacks) never come from a client, so they are not here.
 *
 * - `new-window` opens a window at `/` showing every project.
 * - `open-in-new-window` opens a window at `route`, handing it `seed` as its
 *   project filter.
 * - `project-link` focuses a window showing `ref`, else creates one seeded
 *   with it, the same as a deep link.
 * - `focus` reveals the window with that id, and does nothing once it closed.
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

/**
 * One project a window's filter shows, with the checkout it lives in on its
 * environment's host. Tools outside the app match a caller's checkout against
 * `workspaceRoot`; the ids still name the project exactly.
 */
export const DesktopWindowProject = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
});
export type DesktopWindowProject = typeof DesktopWindowProject.Type;

/** A window's project filter: every project, or the listed ones. */
export const DesktopWindowProjectScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("projects"), projects: Schema.Array(DesktopWindowProject) }),
]);
export type DesktopWindowProjectScope = typeof DesktopWindowProjectScope.Type;

/** A renderer reporting its own window's project filter to the desktop shell. */
export const DesktopWindowProjects = Schema.Struct({
  windowId: Schema.String,
  scope: DesktopWindowProjectScope,
});
export type DesktopWindowProjects = typeof DesktopWindowProjects.Type;
