// Fork seam: workspace reads and previews may cross symlinks whose targets leave the
// workspace root only when the `followExternalWorkspaceSymlinks` server setting is on.
// The settings service is looked up optionally so callers gain no requirement; `server.ts`
// provides it. Without it, or on a settings error, the containment guard stays closed.
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";

/** Whether a path whose realpath leaves the workspace root may still be read. */
export const externalSymlinksAllowed: Effect.Effect<boolean> = Effect.serviceOption(
  ServerSettings.ServerSettingsService,
).pipe(
  Effect.flatMap((maybeSettings) =>
    maybeSettings._tag !== "Some"
      ? Effect.succeed(false)
      : maybeSettings.value.getSettings.pipe(
          Effect.map((settings) => settings.followExternalWorkspaceSymlinks),
          Effect.catchTags({
            ServerSettingsError: (error) => Effect.logWarning(error).pipe(Effect.as(false)),
          }),
        ),
  ),
);
