import { describe, expect, it } from "@effect/vitest";
import type { ProjectScript } from "@t3tools/contracts";

import {
  GENERATED_SETUP_COMMAND,
  refreshPersistedSetupScript,
  refreshPersistedSetupScripts,
} from "./ProjectSetupScriptRunner.ts";

const generatedSetupScripts = [
  {
    id: "setup-worktree",
    name: "Setup Worktree",
    command:
      "vp i && ln -sf $T3CODE_PROJECT_ROOT/.env .env && " +
      "ln -sf $T3CODE_PROJECT_ROOT/infra/relay/.env infra/relay/.env && " +
      "node apps/web/scripts/warm-dep-cache.ts",
  },
  {
    id: "setup-worktree-windows",
    name: "Setup Worktree (Windows)",
    command:
      'vp i && New-Item -ItemType SymbolicLink -Path .env -Target "$env:T3CODE_PROJECT_ROOT\\.env" -Force && ' +
      'New-Item -ItemType SymbolicLink -Path "infra\\relay\\.env" -Target "$env:T3CODE_PROJECT_ROOT\\infra\\relay\\.env" -Force && ' +
      "node apps\\web\\scripts\\warm-dep-cache.ts",
  },
] as const;

const legacyGeneratedScript: ProjectScript = {
  id: generatedSetupScripts[0].id,
  name: generatedSetupScripts[0].name,
  command: generatedSetupScripts[0].command,
  icon: "configure",
  runOnWorktreeCreate: true,
};

describe("persisted fork setup script refresh", () => {
  it("refreshes previously imported generated setup commands", () => {
    for (const generated of generatedSetupScripts) {
      expect(
        refreshPersistedSetupScript({
          ...generated,
          icon: "configure",
          runOnWorktreeCreate: true,
        }),
      ).toEqual({
        ...generated,
        name: "Setup Worktree",
        command: GENERATED_SETUP_COMMAND,
        icon: "configure",
        runOnWorktreeCreate: true,
      });
    }
  });

  it("collapses the two exact generated platform entries into one", () => {
    const scripts: ProjectScript[] = generatedSetupScripts.map((script) => ({
      ...script,
      command: script.command.replace(/^vp i(?= &&)/u, "vp i --frozen-lockfile"),
      icon: "configure",
      runOnWorktreeCreate: true,
    }));

    expect(refreshPersistedSetupScripts(scripts)).toEqual([
      {
        ...scripts[0],
        name: "Setup Worktree",
        command: GENERATED_SETUP_COMMAND,
      },
    ]);
  });

  it("preserves intentional command and metadata customization", () => {
    const customCommand = {
      ...legacyGeneratedScript,
      command: "vp i && ./scripts/configure-worktree.sh",
    };
    const customMetadata = {
      ...legacyGeneratedScript,
      previewUrl: "http://localhost:5173",
      autoOpenPreview: true,
    };

    expect(refreshPersistedSetupScript(customCommand)).toBe(customCommand);
    expect(refreshPersistedSetupScript(customMetadata)).toBe(customMetadata);
  });
});
