// @effect-diagnostics nodeBuiltinImport:off - Static repository guard reads the checked-in T3 action file.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

type T3ProjectScript = {
  readonly name: string;
  readonly command: string;
  readonly icon?: string;
  readonly runOnWorktreeCreate?: boolean;
};

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const projectFile = JSON.parse(NodeFS.readFileSync(NodePath.join(repoRoot, "t3.json"), "utf8")) as {
  readonly scripts?: readonly T3ProjectScript[];
};
const scripts = projectFile.scripts ?? [];

describe("dev app T3 actions", () => {
  it("keeps setup as the only worktree-create action", () => {
    assert.deepStrictEqual(scripts[0], {
      name: "Setup Worktree",
      command: "node scripts/setup-worktree.ts",
      icon: "configure",
      runOnWorktreeCreate: true,
    });
    assert.deepStrictEqual(
      scripts.filter((script) => script.runOnWorktreeCreate).map((script) => script.name),
      ["Setup Worktree"],
    );
  });

  it("exposes explicit shared launcher surfaces and retains existing tools", () => {
    const commands = new Map(scripts.map((script) => [script.name, script.command]));
    assert.deepStrictEqual(
      Object.fromEntries(
        ["Dev Web", "Dev Web (External)", "Dev Desktop"].map((name) => [name, commands.get(name)]),
      ),
      {
        "Dev Web": "vp run dev:app --preview",
        "Dev Web (External)": "vp run dev:app --external",
        "Dev Desktop": "vp run dev:app --desktop",
      },
    );
    assert.deepStrictEqual(
      Object.fromEntries(
        ["Dev Desktop Agent", "Dev Desktop Agent URL", "Hyprland Workspace"].map((name) => [
          name,
          commands.get(name),
        ]),
      ),
      {
        "Dev Desktop Agent": "vp run dev:desktop:agent",
        "Dev Desktop Agent URL": "vp run dev:desktop:agent:url",
        "Hyprland Workspace": "vp run hypr:workspace",
      },
    );
  });
});
