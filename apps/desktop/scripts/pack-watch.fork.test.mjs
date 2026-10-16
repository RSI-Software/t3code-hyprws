import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { build } from "vite-plus/pack";
import { assert, it } from "vite-plus/test";

import desktopConfig from "../vite.config.ts";

it("ignores installed dependencies but keeps symlinked workspace sources watchable", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pack-watch-"));
  try {
    const installed = NodePath.join(directory, "node_modules/dependency");
    await NodeFSP.mkdir(installed, { recursive: true });
    const dependencyFile = NodePath.join(installed, "index.js");
    await NodeFSP.writeFile(dependencyFile, "export const dependency = 1;");
    await NodeFSP.mkdir(NodePath.join(directory, "node_modules/@t3tools"));
    const workspaceFiles = [];
    for (const name of ["contracts", "shared"]) {
      const workspace = NodePath.join(directory, "packages", name);
      await NodeFSP.mkdir(workspace, { recursive: true });
      const source = NodePath.join(workspace, "index.js");
      await NodeFSP.writeFile(source, `export const ${name} = 1;`);
      workspaceFiles.push(await NodeFSP.realpath(source));
      await NodeFSP.symlink(
        workspace,
        NodePath.join(directory, "node_modules/@t3tools", name),
        "junction",
      );
    }
    const entry = NodePath.join(directory, "main.ts");
    await NodeFSP.writeFile(
      entry,
      `import { dependency } from "dependency";
import { contracts } from "@t3tools/contracts";
import { shared } from "@t3tools/shared";
console.log(dependency + contracts + shared);`,
    );

    const modules = new Set();
    await build({
      ...desktopConfig.pack[0],
      cwd: directory,
      config: false,
      tsconfig: false,
      entry: [entry],
      write: false,
      onSuccess: undefined,
      logLevel: "silent",
      plugins: [
        {
          name: "inspect-watch-inputs",
          moduleParsed(module) {
            modules.add(module.id);
          },
        },
      ],
    });
    const ignored = await NodeFSP.realpath(dependencyFile);
    const watched = [await NodeFSP.realpath(entry), ...workspaceFiles];
    for (const source of [ignored, ...watched]) assert.ok(modules.has(source), source);
    for (const config of desktopConfig.pack) {
      assert.ok(config.ignoreWatch.test(ignored));
      for (const source of watched) assert.ok(!config.ignoreWatch.test(source), source);
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
