// @effect-diagnostics nodeBuiltinImport:off - Pins the checked-in task graph by reading the config files as text.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/**
 * The desktop development launch clobbered this checkout's shared client
 * outputs through one task-graph edge: the desktop `dev` tasks pulled in
 * `t3#build`, which cleans `apps/server/dist` (taking `dist/client` with it)
 * and copies a loopback-baked `apps/web/dist` over `apps/server/dist/client`.
 * Nothing in a dev desktop launch consumes a built client (the renderer is
 * the Vite dev server), so those tasks now depend on `t3#dev:bundle`, which
 * refreshes `dist/bin.mjs` in place without cleaning and without the web
 * build. These assertions pin that shape so the edge cannot creep back.
 */

function readRepoFile(relativePath: string): string {
  return NodeFS.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

/**
 * Extracts a `key: { ... }` block by brace matching. The pinned config files
 * keep braces out of their task command strings, so counting braces is safe
 * here.
 */
function taskBlock(source: string, key: string): string {
  const marker = `${key}: {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`task block ${key} not found`);
  let depth = 0;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`task block ${key} is unbalanced`);
}

const desktopConfig = readRepoFile("apps/desktop/vite.config.ts");
const serverConfig = readRepoFile("apps/server/vite.config.ts");
const serverPackageJson = JSON.parse(readRepoFile("apps/server/package.json")) as {
  readonly scripts: Record<string, string>;
};

describe("desktop development task graph", () => {
  it("points the desktop dev tasks at the in-place server refresh, not the packaged build", () => {
    for (const task of ["dev", '"dev:electron"']) {
      const block = taskBlock(desktopConfig, task);
      expect(block).toContain('dependsOn: ["t3#dev:bundle"]');
      expect(block).not.toContain("t3#build");
    }
    // The packaged desktop build keeps the full chain; it is the only place
    // the old edge remains.
    expect(taskBlock(desktopConfig, "build")).toContain('dependsOn: ["t3#build"]');
  });

  it("keeps the server dev:bundle refresh free of the web build and the copy", () => {
    const block = taskBlock(serverConfig, '"dev:bundle"');
    expect(block).toContain('command: "node --run build:bundle:dev"');
    expect(block).toContain("cache: false");
    expect(block).not.toContain("dependsOn");
    // The packaged server build keeps the web build that feeds dist/client.
    expect(taskBlock(serverConfig, "build")).toContain('dependsOn: ["@t3tools/web#build"]');
  });

  it("refreshes the server bundle in place: same packs as the packaged build, without the clean", () => {
    // The dev chain must be exactly the packaged chain with the cleaning
    // disabled, whatever upstream does to `build:bundle`.
    const bundledChain = serverPackageJson.scripts["build:bundle"]
      .split(" && ")
      .map((step) => (step === "vp pack" ? "vp pack --no-clean" : step))
      .join(" && ");
    expect(serverPackageJson.scripts["build:bundle"].startsWith("vp pack")).toBe(true);
    expect(serverPackageJson.scripts["build:bundle:dev"]).toBe(bundledChain);
  });
});
