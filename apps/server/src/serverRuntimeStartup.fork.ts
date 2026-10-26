import { CommandId, type ProjectSettingsOverrides } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { refreshPersistedSetupScripts } from "./project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "./serverSettings.ts";

/**
 * Startup phase: persist the refreshed form of every unmodified legacy generated
 * setup script, so project settings show the command worktree setup runs.
 * Project settings overrides win over `project.scripts`, so both are refreshed.
 */
export const reconcileSetupScriptsFork = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const projectService = yield* ProjectService.ProjectService;
  const projects = yield* (yield* ProjectStore.ProjectStoreV2).listShells();

  for (const project of projects) {
    const scripts = refreshPersistedSetupScripts(project.scripts);
    if (scripts === project.scripts) {
      continue;
    }
    yield* projectService.update({
      commandId: CommandId.make(`server:setup-script-refresh:${yield* crypto.randomUUIDv4()}`),
      projectId: project.id,
      scripts,
    });
  }

  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const { projectSettingsOverrides } = yield* serverSettings.getSettings;
  const refreshed: Record<string, ProjectSettingsOverrides> = {};
  for (const [projectId, entry] of Object.entries(projectSettingsOverrides)) {
    const current = entry.defaultProjectScripts;
    if (current === undefined) continue;
    const scripts = refreshPersistedSetupScripts(current);
    if (scripts !== current) refreshed[projectId] = { ...entry, defaultProjectScripts: scripts };
  }
  if (Object.keys(refreshed).length > 0) {
    // A patch entry replaces that project's whole override set, hence the full entry.
    yield* serverSettings.updateSettings({ projectSettingsOverrides: refreshed });
  }
}).pipe(
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterrupts(cause),
    (cause) => Effect.logWarning("persisted project setup script reconciliation failed", { cause }),
  ),
);
