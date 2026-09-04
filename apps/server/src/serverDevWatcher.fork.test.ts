// @effect-diagnostics nodeBuiltinImport:off - This contract reads workspace manifests and source imports.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

type PackageManifest = {
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

const serverSourceDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const serverDir = NodePath.dirname(serverSourceDir);

const readPackageManifest = (path: string): PackageManifest =>
  JSON.parse(NodeFS.readFileSync(path, "utf8")) as PackageManifest;

const serverPackageJson = readPackageManifest(NodePath.join(serverDir, "package.json"));

const importSpecifierPattern = /\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g;

const runtimeSourceFiles = NodeFS.readdirSync(serverSourceDir, { recursive: true })
  .filter(
    (path): path is string =>
      typeof path === "string" &&
      path.endsWith(".ts") &&
      !path.endsWith(".test.ts") &&
      !path.endsWith(".fork.test.ts") &&
      !path.endsWith(".fork-test-harness.ts"),
  )
  .map((path) => NodePath.join(serverSourceDir, path));

const workspaceDependencies = new Set(
  Object.entries({
    ...serverPackageJson.dependencies,
    ...serverPackageJson.devDependencies,
  })
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([name]) => name),
);

const resolveWorkspaceDependency = (specifier: string): string | undefined =>
  [...workspaceDependencies].find(
    (dependency) => specifier === dependency || specifier.startsWith(`${dependency}/`),
  );

const importedWorkspaceDependencies = new Set(
  runtimeSourceFiles.flatMap((path) => {
    const source = NodeFS.readFileSync(path, "utf8");
    return [...source.matchAll(importSpecifierPattern)]
      .map((match) => match[1])
      .filter((specifier): specifier is string => specifier !== undefined)
      .map(resolveWorkspaceDependency)
      .filter((dependency): dependency is string => dependency !== undefined);
  }),
);

it("watches only server and imported workspace source roots", () => {
  const command = serverPackageJson.scripts?.dev;
  if (command === undefined) {
    assert.fail("apps/server/package.json must define scripts.dev");
  }

  const commandTokens = command.split(/\s+/u);
  const watchPaths = commandTokens
    .filter((token) => token.startsWith("--watch-path="))
    .map((token) => token.slice("--watch-path=".length));

  assert.deepStrictEqual(commandTokens.slice(0, 2), ["node", "--watch-path=src"]);
  assert.strictEqual(commandTokens.at(-1), "src/bin.ts");
  assert.notInclude(commandTokens, "--watch");
  assert.deepStrictEqual(watchPaths[0], "src");

  const watchedWorkspaceDependencies = watchPaths.slice(1).map((watchPath) => {
    assert.strictEqual(NodePath.posix.basename(watchPath), "src");
    assert.notMatch(watchPath, /(?:^|\/)(?:node_modules|dist|tests?|scripts)(?:\/|$)/u);

    const packageJsonPath = NodePath.resolve(serverDir, watchPath, "..", "package.json");
    const packageName = readPackageManifest(packageJsonPath).name;
    assert.isString(packageName);
    return packageName;
  });

  assert.deepStrictEqual(
    watchedWorkspaceDependencies.toSorted(),
    [...importedWorkspaceDependencies].toSorted(),
  );
  assert.deepStrictEqual(watchedWorkspaceDependencies, [
    "@t3tools/contracts",
    "effect-acp",
    "effect-codex-app-server",
    "@t3tools/shared",
    "@t3tools/tailscale",
  ]);
});
