import { assert, it } from "@effect/vitest";

import {
  fileExtension,
  forkCommitSourceExtensions,
  isDefinitionOrImportSite,
  isProductSourcePath,
  isRetireEvidenceSite,
} from "./fork-retire-probe.ts";

// The exact paths that carried retire verdicts on the `v0.0.41-nightly.20260908.1414` walk.
it("refuses every vendored, harness, CI, and documentation path the walk mistook for source", () => {
  for (const path of [
    ".macroscope/check-run-agents/effect-service-conventions.md",
    ".agents/skills/test-t3-app/SKILL.md",
    ".github/VOUCHED.td",
    ".cursor/rules/cursor-cloud.mdc",
    ".repos/effect-smol/LLMS.md",
    ".devcontainer/devcontainer.json",
    "docs/internals/fork-delta.md",
    "apps/web/.storybook/preview.ts",
  ])
    assert.isFalse(isProductSourcePath(path), path);
  for (const path of [
    "apps/web/src/localApi.ts",
    "packages/contracts/src/window.ts",
    "scripts/fork-sync.ts",
  ])
    assert.isTrue(isProductSourcePath(path), path);
});

it("reads the source file types a fork commit changed, ignoring prose and opaque files", () => {
  const diff = [
    "+++ b/apps/web/src/window.ts",
    "+export const ScopedProjectWindow = 1;",
    "+++ b/apps/web/src/window.tsx",
    "+const a = 1;",
    "+++ b/docs/internals/fork-delta.md",
    "+prose about scoped project windows",
    "+++ b/pnpm-lock.yaml",
    "+  /some-package@1.0.0:",
    "+++ b/apps/web/src/__snapshots__/window.snap",
    "+snapshot",
    "+++ /dev/null",
  ].join("\n");
  assert.deepStrictEqual([...forkCommitSourceExtensions(diff)].sort(), [".ts", ".tsx"]);
});

it("counts a name where it is defined or imported, not where it is merely mentioned", () => {
  assert.isTrue(
    isDefinitionOrImportSite("SharedWindowScope", "export const SharedWindowScope = 2;"),
  );
  assert.isTrue(isDefinitionOrImportSite("ScopedWindow", "import { ScopedWindow } from './w.ts';"));
  assert.isTrue(isDefinitionOrImportSite("window.perProject", '  "window.perProject": true,'));
  assert.isTrue(
    isDefinitionOrImportSite("opens one window", 'it("opens one window per project", () => {});'),
  );
  // A bare package or environment-variable name reads as a match on any line that names it.
  assert.isFalse(
    isDefinitionOrImportSite("@t3tools/contracts", "// see @t3tools/contracts for the shape"),
  );
  assert.isFalse(isDefinitionOrImportSite("VITE_HTTP_URL", "Never set VITE_HTTP_URL for dev."));
  assert.isFalse(isDefinitionOrImportSite("react-native", "The mobile app is react-native."));
});

it("takes the extension from the basename and never from a leading dot", () => {
  assert.strictEqual(fileExtension("apps/web/src/a.test.ts"), ".ts");
  assert.strictEqual(fileExtension("apps/web/.env"), "");
  assert.strictEqual(fileExtension("Makefile"), "");
});

it("requires product source, a file type the commit changed, and a definition site together", () => {
  const extensions = new Set([".ts"]);
  const definition = "export const SharedWindowScope = 2;";
  assert.isTrue(
    isRetireEvidenceSite("SharedWindowScope", "apps/web/src/w.ts", definition, extensions),
  );
  // Right shape, wrong tree.
  assert.isFalse(isRetireEvidenceSite("SharedWindowScope", ".agents/w.ts", definition, extensions));
  // Right tree, wrong file type for this commit.
  assert.isFalse(
    isRetireEvidenceSite("SharedWindowScope", "apps/web/src/w.py", definition, extensions),
  );
  // Right tree and type, but the name is only mentioned.
  assert.isFalse(
    isRetireEvidenceSite(
      "SharedWindowScope",
      "apps/web/src/w.ts",
      "// SharedWindowScope",
      extensions,
    ),
  );
});
