// Fork-owned seam for the global external-workspace-symlink policy
// (RSI-Software/t3code-hyprws#951, reshaping 565594bd75).
//
// Upstream's read resolver hard-blocks any path whose resolved target leaves
// the workspace root. The fork adds a server-authoritative opt-in: when the
// `followExternalWorkspaceSymlinks` server setting is enabled, reads may cross
// symlinks whose targets are outside the root. The settings service is looked
// up optionally so the seam adds no requirement to `WorkspaceFileSystem.layer`
// — upstream files and test harnesses keep upstream text, and the production
// wiring in `server.ts` provides the service through one marked hook. Without
// the service (or on a settings error) the containment guard stays closed.
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";

const blocked = Effect.succeed(false);

export interface ExternalSymlinksFork {
  /**
   * Whether the read may proceed through a symlink whose resolved target sits
   * outside the workspace root. `resolvesOutsideWorkspace` is upstream's own
   * escape computation over the realpath.
   */
  readonly follows: (resolvesOutsideWorkspace: boolean) => Effect.Effect<boolean>;
}

/** @public Fork seam construction, part of the canonical fork module API. */
export const makeExternalSymlinksFork = (): ExternalSymlinksFork => ({
  follows: (resolvesOutsideWorkspace) =>
    resolvesOutsideWorkspace
      ? Effect.serviceOption(ServerSettings.ServerSettingsService).pipe(
          Effect.flatMap((maybeSettings) => {
            if (maybeSettings._tag !== "Some") return blocked;
            return maybeSettings.value.getSettings.pipe(
              Effect.map((settings) => settings.followExternalWorkspaceSymlinks),
              Effect.catchTag("ServerSettingsError", (error) =>
                Effect.logWarning(error).pipe(Effect.as(false)),
              ),
            );
          }),
        )
      : blocked,
});
