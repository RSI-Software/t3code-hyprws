// @effect-diagnostics nodeBuiltinImport:off - The guard reads the manifest and the boundary sources from disk.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

// The rich Markdown editor is the fork's only Milkdown consumer, and every
// package it declares widens `pnpm-lock.yaml` — the fork's one regenerable path,
// and a rebase stop of its own. `@milkdown/kit` re-exports the granular packages
// and `@milkdown/react` pulls `@milkdown/crepe`, so either one drags a Vue
// runtime and CodeMirror into a React-only app and hundreds of lockfile lines
// into the fork delta. The binding `@milkdown/react` provides is one effect,
// kept in MarkdownRichEditor.tsx.
const APP_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const SOURCE_ROOT = NodePath.join(APP_ROOT, "src");
const BOUNDARY = "src/components/files";

const UMBRELLA_PACKAGES = new Map([
  ["@milkdown/kit", "re-exports the granular packages the boundary imports directly"],
  [
    "@milkdown/react",
    "depends on @milkdown/crepe, which pulls Vue and CodeMirror into a React app",
  ],
]);

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

/** `@milkdown/prose/state` is declared as `@milkdown/prose`; subpaths are not packages. */
const packageName = (specifier: string): string => specifier.split("/").slice(0, 2).join("/");

/**
 * Matches every shape that pulls a Milkdown package into the bundle: `from "…"`,
 * a bare side-effect `import "…"`, a dynamic `import("…")`, and `require("…")`.
 * A lazily loaded editor still widens the lockfile, so it has to count here.
 */
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](@milkdown\/[^"']+)["']/g;

const importSites = (): ReadonlyMap<string, ReadonlyArray<string>> => {
  const sites = new Map<string, Array<string>>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const relative = NodePath.relative(APP_ROOT, file);
    for (const match of NodeFS.readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)) {
      const name = packageName(match[1] ?? "");
      const seen = sites.get(name) ?? [];
      if (!seen.includes(relative)) seen.push(relative);
      sites.set(name, seen);
    }
  }
  return sites;
};

const declaredPackages = (): ReadonlyArray<string> => {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(APP_ROOT, "package.json"), "utf8"),
  ) as { readonly dependencies?: Record<string, string> };
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@milkdown/"))
    .toSorted();
};

describe("rich Markdown dependency boundary", () => {
  it("declares exactly the Milkdown packages the boundary imports", () => {
    const imported = [...importSites().keys()].toSorted();
    expect(imported).not.toStrictEqual([]);
    expect(declaredPackages()).toStrictEqual(imported);
  });

  it("keeps the umbrella and React-wrapper packages out of the manifest", () => {
    const declared = new Set(declaredPackages());
    for (const [name, reason] of UMBRELLA_PACKAGES) {
      expect(declared.has(name), `${name} is back in apps/web/package.json; it ${reason}`).toBe(
        false,
      );
    }
  });

  it("keeps every Milkdown import inside the fork-owned boundary", () => {
    const outside = [...importSites().values()]
      .flat()
      .filter((path) => !path.startsWith(`${BOUNDARY}/`))
      .toSorted();
    expect(outside).toStrictEqual([]);
  });
});
