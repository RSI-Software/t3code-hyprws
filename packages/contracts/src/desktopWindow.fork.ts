import * as Schema from "effect/Schema";

import { ScopedProjectRef } from "./environment.ts";

/**
 * A hash route inside the app, such as `/` or `/project/env/proj`. Leading
 * `//` is refused so a route can never read as a protocol-relative URL.
 */
export const DesktopWindowRoute = Schema.String.check(Schema.isPattern(/^\/(?!\/)/u));

/**
 * The window requests a client may send to the desktop shell
 * (RSI-Software/t3code-hyprws#1343). Launch requests (second launch, deep
 * links, OAuth callbacks) never come from a client, so they are not here.
 *
 * - `new-window` opens a window at `/` showing every project.
 * - `open-in-new-window` opens a window at `route`, handing it `seed` as its
 *   project filter.
 * - `focus` reveals the window with that id, and does nothing once it closed.
 */
export const DesktopWindowRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new-window") }),
  Schema.Struct({
    kind: Schema.Literal("open-in-new-window"),
    route: DesktopWindowRoute,
    seed: ScopedProjectRef,
  }),
  Schema.Struct({ kind: Schema.Literal("focus"), windowId: Schema.String }),
]);
export type DesktopWindowRequest = typeof DesktopWindowRequest.Type;
