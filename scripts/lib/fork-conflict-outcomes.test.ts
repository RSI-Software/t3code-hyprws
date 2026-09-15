// @effect-diagnostics nodeBuiltinImport:off - Outcome execution writes real files in a fixture worktree.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  SystemCommandRunner,
  type CwdCommandRunner as CommandRunner,
  type CommandResult,
  type CwdCommandRunner,
} from "./fork-command.ts";
import {
  classifyConflictOutcome,
  everyConflictIsCoInsertion,
  executeConflictOutcome,
  isUnresolved,
  preservesUpstreamAdditions,
} from "./fork-conflict-outcomes.ts";
import type { ForkHookAnchor } from "./fork-hooks.ts";

const stages = (
  base: string,
  ours: string,
  theirs: string,
): Parameters<typeof classifyConflictOutcome>[0] => ({ base, ours, theirs });

it("applies fork doctrine to a conflicted seam in one total function", () => {
  // Only upstream moved.
  assert.deepInclude(classifyConflictOutcome(stages("a\n", "b\n", "a\n")), {
    take: "ours",
    conflictClass: "mechanical",
    source: "upstream-only",
  });
  // Only the fork moved, so the fork feature keeps working.
  assert.deepInclude(classifyConflictOutcome(stages("a\n", "a\n", "c\n")), {
    take: "theirs",
    conflictClass: "mechanical",
    source: "fork-only",
  });
  // Two approaches to the same seam: keep both, and say the fork side is worth a second look.
  const both = classifyConflictOutcome(stages("a\n", "b\n", "c\n"));
  assert.deepInclude(both, { take: "union", conflictClass: "seam-moved", source: "keep-both" });
  assert.include(both.resolution, "consider keeping ours");
});

it("refuses a resolution that drops a line upstream added", () => {
  // The fork is additive: dropping its own line is allowed, dropping upstream's never is.
  assert.isTrue(preservesUpstreamAdditions("a\n", "a\nup\n", "a\nup\nfork\n"));
  assert.isTrue(preservesUpstreamAdditions("a\nold\n", "a\n", "a\nfork\n"));
  assert.isFalse(preservesUpstreamAdditions("a\n", "a\nup\n", "a\nfork\n"));
  // Blank lines are formatting, not content.
  assert.isTrue(preservesUpstreamAdditions("a\n", "a\n\nup\n", "a\nup\n"));
});

const fixture = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-outcome-test-"));
  NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
};

/** Stage the three rebase index stages for one path, exactly as a conflicted replay leaves them. */
const stageConflict = (
  root: string,
  path: string,
  contents: { readonly base: string; readonly ours: string; readonly theirs: string },
): void => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  const entries = ([1, 2, 3] as const)
    .map((stage) => {
      const value = stage === 1 ? contents.base : stage === 2 ? contents.ours : contents.theirs;
      const sha = NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: root,
        input: value,
      })
        .toString()
        .trim();
      return `100644 ${sha} ${stage}\t${path}`;
    })
    .join("\n");
  NodeChildProcess.execFileSync("git", ["update-index", "--index-info"], {
    cwd: root,
    input: `${entries}\n`,
  });
};

it("resolves a conflicted path from its index stages and stages the result", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  const path = "apps/web/src/window.ts";
  try {
    stageConflict(root, path, {
      base: "shared\n",
      ours: "shared\nupstream\n",
      theirs: "shared\nfork\n",
    });
    const outcome = executeConflictOutcome(runner, root, path);
    assert.isFalse(isUnresolved(outcome));
    if (isUnresolved(outcome)) return;
    assert.strictEqual(outcome.take, "union");
    const resolved = NodeFS.readFileSync(NodePath.join(root, path), "utf8");
    assert.include(resolved, "upstream");
    assert.include(resolved, "fork");
    assert.notInclude(resolved, "<<<<<<<");
    // Staged, so `git rebase --continue` sees a resolved path and not a dirty tree.
    assert.strictEqual(
      NodeChildProcess.execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: root,
      })
        .toString()
        .trim(),
      "",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("declines the shapes a maintainer owns instead of guessing", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  try {
    // Add/add: no merge base on this path.
    const added = "apps/web/src/added.ts";
    NodeFS.mkdirSync(NodePath.join(root, "apps/web/src"), { recursive: true });
    for (const [stage, value] of [
      [2, "upstream\n"],
      [3, "fork\n"],
    ] as const) {
      const sha = NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: root,
        input: value,
      })
        .toString()
        .trim();
      NodeChildProcess.execFileSync("git", ["update-index", "--index-info"], {
        cwd: root,
        input: `100644 ${sha} ${stage}\t${added}\n`,
      });
    }
    const noBase = executeConflictOutcome(runner, root, added);
    assert.isTrue(isUnresolved(noBase));
    if (!isUnresolved(noBase)) return;
    assert.include(noBase.reason, "no common ancestor");

    // Binary: nothing here can read it, so nothing here may resolve it.
    const binary = "apps/web/src/icon.bin";
    stageConflict(root, binary, {
      base: "\0base",
      ours: "\0upstream",
      theirs: "\0fork",
    });
    const opaque = executeConflictOutcome(runner, root, binary);
    assert.isTrue(isUnresolved(opaque));
    if (!isUnresolved(opaque)) return;
    assert.include(opaque.reason, "binary");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("declines a resolution that would drop an upstream addition", () => {
  const root = fixture();
  const path = "apps/web/src/window.ts";
  // The check bites when a union merge cannot carry an upstream line through, so drive it from a
  // merge that loses one.
  const runner: CwdCommandRunner = {
    run(command, args, cwd, input, env): CommandResult {
      if (command === "git" && args[0] === "merge-file")
        return { status: 0, stdout: "shared\nfork\n", stderr: "" };
      return new SystemCommandRunner().run(command, args, cwd, input, env);
    },
  };
  try {
    stageConflict(root, path, {
      base: "shared\n",
      ours: "shared\nupstream\n",
      theirs: "shared\nfork\n",
    });
    const outcome = executeConflictOutcome(runner, root, path);
    assert.isTrue(isUnresolved(outcome));
    if (!isUnresolved(outcome)) return;
    assert.include(outcome.reason, "upstream added");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("mechanically applies a fork deletion when upstream only moved its context", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  const path = "apps/web/src/routes/settings.tsx";
  try {
    // Seam 2: upstream wraps the original Escape effect in settings scope, while the fork deletes
    // that byte-identical block and uses its scoped leave hook instead.
    stageConflict(root, path, {
      base: [
        "navigateBackWithinApp();",
        "useEffect(() => onEscape(navigateBackWithinApp));",
        "",
      ].join("\n"),
      ours: [
        "useSettingsScope();",
        "navigateBackWithinApp();",
        "useEffect(() => onEscape(navigateBackWithinApp));",
        "",
      ].join("\n"),
      theirs: "useLeaveFullPage($&);\n",
    });
    const outcome = executeConflictOutcome(runner, root, path);
    assert.isFalse(isUnresolved(outcome));
    if (isUnresolved(outcome)) return;
    assert.deepInclude(outcome, {
      take: "theirs",
      conflictClass: "mechanical",
      source: "fork-only",
      resolution:
        "outcome executor: moved-deletion (fork deletion over byte-identical upstream base)",
    });
    const resolved = NodeFS.readFileSync(NodePath.join(root, path), "utf8");
    assert.include(resolved, "useSettingsScope();");
    assert.include(resolved, "useLeaveFullPage($&);");
    assert.notInclude(resolved, "navigateBackWithinApp");
    assert.notInclude(resolved, "onEscape");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("mechanically applies an upstream deletion when the fork left its base bytes untouched", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  const path = "apps/web/src/routes/settings.tsx";
  try {
    stageConflict(root, path, {
      base: "navigateBackWithinApp();\n",
      ours: "useSettingsScope();\n",
      theirs: "navigateBackWithinApp();\nuseLeaveFullPage();\n",
    });
    const outcome = executeConflictOutcome(runner, root, path);
    assert.isFalse(isUnresolved(outcome));
    if (isUnresolved(outcome)) return;
    assert.deepInclude(outcome, {
      take: "ours",
      conflictClass: "mechanical",
      source: "upstream-only",
      resolution:
        "outcome executor: moved-deletion (upstream deletion over byte-identical fork base)",
    });
    const resolved = NodeFS.readFileSync(NodePath.join(root, path), "utf8");
    assert.include(resolved, "useSettingsScope();");
    assert.include(resolved, "useLeaveFullPage();");
    assert.notInclude(resolved, "navigateBackWithinApp");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("resolves the real ChatView dependency-array conflict from 347da0d7ad", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  const path = "apps/web/src/components/ChatView.tsx";
  const chatView = (firstDependencies: string, secondDependencies: string) =>
    [
      "const settings = {};",
      "const routeFamily = { draft: (id: string) => id };",
      'const runtimeMode = "legacy";',
      'const defaultRuntimeMode = "default";',
      "const openOrReuseProjectDraftThread = useCallback(",
      "  async () => {",
      "    await navigate(routeFamily.draft(nextDraftId));",
      "    resolveProjectSettings(settings, activeProject.id, activeProject);",
      "  },",
      "  [",
      firstDependencies,
      "  ],",
      ");",
      "",
      "const submit = useCallback(",
      "  () => {",
      "    startThreadTurn({ runtimeMode: defaultRuntimeMode });",
      "    navigate(routeFamily.draft(nextDraftId));",
      "  },",
      "  [",
      secondDependencies,
      "  ],",
      ");",
      "",
    ].join("\n");
  try {
    // These are the two regions git left in ChatView.tsx when 347da0d7ad replayed onto `.1576`.
    stageConflict(root, path, {
      base: chatView("", "    runtimeMode,"),
      ours: chatView("      settings,", "    defaultRuntimeMode,"),
      theirs: chatView("      routeFamily,", "    routeFamily,\n    runtimeMode,"),
    });
    const outcome = executeConflictOutcome(runner, root, path);
    assert.isFalse(isUnresolved(outcome));
    if (isUnresolved(outcome)) return;
    assert.deepInclude(outcome, {
      take: "union",
      conflictClass: "mechanical",
      source: "keep-both",
    });
    assert.include(
      outcome.resolution,
      "dropped runtimeMode because the hook body does not read it",
    );
    const resolved = NodeFS.readFileSync(NodePath.join(root, path), "utf8");
    assert.include(resolved, "      settings,\n      routeFamily,");
    assert.include(resolved, "    defaultRuntimeMode,\n    routeFamily,");
    assert.notInclude(resolved, "    runtimeMode,");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("declines unreferenced dependency entries and non-dependency rewrites", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  const hook = (body: string, dependencies: string) =>
    ["useEffect(", "  () => {", body, "  },", "  [", dependencies, "  ],", ");", ""].join("\n");
  try {
    const unused = "apps/web/src/components/unused.tsx";
    stageConflict(root, unused, {
      base: hook("    report();", "    legacy,"),
      ours: hook("    report();", "    settings,"),
      theirs: hook("    report();", "    routeFamily,"),
    });
    assert.isTrue(isUnresolved(executeConflictOutcome(runner, root, unused)));

    // `settings` is read in the ternary alternative. Its trailing colon is ambiguous enough that
    // the local scanner must decline rather than incorrectly pruning a live dependency.
    const ternary = "apps/web/src/components/ternary.tsx";
    stageConflict(root, ternary, {
      base: hook("    return routeFamily ? settings : fallback;", "    legacy,"),
      ours: hook("    return routeFamily ? settings : fallback;", "    settings,"),
      theirs: hook("    return routeFamily ? settings : fallback;", "    routeFamily,"),
    });
    assert.isTrue(isUnresolved(executeConflictOutcome(runner, root, ternary)));

    // A property key alone does not prove that runtimeMode is read, so it cannot authorize
    // removing that dependency just because routeFamily is unambiguous.
    const propertyKeyOnly = "apps/web/src/components/property-key-only.tsx";
    stageConflict(root, propertyKeyOnly, {
      base: hook(
        "    report({ runtimeMode: defaultRuntimeMode });\n    consume(routeFamily);",
        "    legacy,",
      ),
      ours: hook(
        "    report({ runtimeMode: defaultRuntimeMode });\n    consume(routeFamily);",
        "    runtimeMode,",
      ),
      theirs: hook(
        "    report({ runtimeMode: defaultRuntimeMode });\n    consume(routeFamily);",
        "    routeFamily,",
      ),
    });
    assert.isTrue(isUnresolved(executeConflictOutcome(runner, root, propertyKeyOnly)));

    // Template interpolation can read an entry, but the local scanner cannot prove that safely.
    const template = "apps/web/src/components/template.tsx";
    const templateSource = [
      "const settings = {};",
      "const routeFamily = {};",
      hook("    return `${settings}`;", "    legacy,"),
    ].join("\n");
    stageConflict(root, template, {
      base: templateSource,
      ours: templateSource.replace("    legacy,", "    settings,"),
      theirs: templateSource.replace("    legacy,", "    routeFamily,"),
    });
    assert.isTrue(isUnresolved(executeConflictOutcome(runner, root, template)));

    const notDependencies = "apps/web/src/components/not-dependencies.tsx";
    stageConflict(root, notDependencies, {
      base: "const setting = legacy;\n",
      ours: "const setting = settings;\n",
      theirs: "const setting = routeFamily;\n",
    });
    assert.isTrue(isUnresolved(executeConflictOutcome(runner, root, notDependencies)));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("declines a seam both sides rewrote, and keeps a pure co-insertion", () => {
  assert.isTrue(
    everyConflictIsCoInsertion(
      ["<<<<<<< upstream", "up", "||||||| base", "=======", "fork", ">>>>>>> fork"].join("\n"),
    ),
  );
  assert.isFalse(
    everyConflictIsCoInsertion(
      ["<<<<<<< upstream", "up", "||||||| base", "old", "=======", "fork", ">>>>>>> fork"].join(
        "\n",
      ),
    ),
  );

  const root = fixture();
  const runner = new SystemCommandRunner();
  const path = "apps/web/src/window.ts";
  try {
    // Both sides rewrote the same call. A union would emit both statements, which is a file that
    // says two things at once, so the executor declines instead of writing it.
    stageConflict(root, path, {
      base: "emit(a, {});\n",
      ours: "emit(a, { retries: 2 });\n",
      theirs: "emit(a, { hyprws: true });\n",
    });
    const rewritten = executeConflictOutcome(runner, root, path);
    assert.isTrue(isUnresolved(rewritten));
    if (!isUnresolved(rewritten)) return;
    assert.strictEqual(
      rewritten.reason,
      "upstream and the fork rewrote the same lines; keeping both would say two things at once, so a maintainer owns this seam",
    );
    // A decline writes nothing, so the conflicted path is left for the maintainer as it was.
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, path)));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("declines a kept-both resolution on a path the lane cannot verify", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  try {
    for (const path of [".github/workflows/ci.yml", "package.json", "docs/user/threads.md"]) {
      stageConflict(root, path, { base: "a\n", ours: "a\nup\n", theirs: "a\nfork\n" });
      const outcome = executeConflictOutcome(runner, root, path);
      assert.isTrue(isUnresolved(outcome), path);
      if (!isUnresolved(outcome)) return;
      assert.include(outcome.reason, "cannot typecheck or test");
    }
    // The same shape inside a workspace resolves, because the lane checks it afterwards.
    const checked = "apps/web/src/window.ts";
    stageConflict(root, checked, { base: "a\n", ours: "a\nup\n", theirs: "a\nfork\n" });
    assert.isFalse(isUnresolved(executeConflictOutcome(runner, root, checked)));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("never resolves a kept commit's file to the upstream side alone", () => {
  const root = fixture();
  const runner = new SystemCommandRunner();
  const path = "apps/web/src/window.ts";
  const body = ["", "const pad = 1;", "const pad2 = 2;", "const pad3 = 3;", ""].join("\n");
  try {
    // Upstream carries a same-named export, which is what retire evidence greps for. The commit is
    // kept, so its own hunk has to survive: taking `ours` here would keep the commit and gut it.
    stageConflict(root, path, {
      base: `export const openWindow = () => null;\n${body}`,
      ours: `export const openWindow = () => upstream();\n${body}`,
      theirs: `export const openWindow = () => null;\n${body}export const forkOnly = () => hyprws();\n`,
    });
    const outcome = executeConflictOutcome(runner, root, path);
    assert.isFalse(isUnresolved(outcome));
    if (isUnresolved(outcome)) return;
    assert.notStrictEqual(outcome.take, "ours");
    const resolved = NodeFS.readFileSync(NodePath.join(root, path), "utf8");
    assert.include(resolved, "forkOnly");
    assert.include(resolved, "upstream()");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

/** Delegates git to the system and answers `vp` (the scoped typecheck) with a canned result. */
const typecheckRunner = (): CommandRunner => {
  const system = new SystemCommandRunner();
  return {
    run: (command, args, cwd, input, env) =>
      command === "vp"
        ? { status: 0, stdout: "", stderr: "" }
        : system.run(command, args, cwd ?? ".", input, env),
  };
};

const SUBSTITUTION_HOOK = "upstream-fixes/test-sub";
const gateManifest = {
  [SUBSTITUTION_HOOK]: {
    path: "packages/contracts/src/settings.ts",
    anchor: { kind: "collection", symbol: "ServerSettingsPatch" },
  },
} as const;

/** A seam where upstream rewrites `rename` and the fork touches other lines beside it. */
const substitutionStages = (forkInterfaceTail: string, forkFileTail: string, keepGone = true) => ({
  base: "export interface ServerSettingsPatch {\n  rename: string;\n  input: { cwd: props.cwd };\n}\n\nexport const tail = 0;\nexport const gone = 2;\n",
  ours: "export interface ServerSettingsPatch {\n  name: string;\n  mount: boolean;\n}\n\nexport const tail = 0;\nexport const gone = 2;\nexport const up = 1;\n",

  theirs: `export interface ServerSettingsPatch {\n  rename: string;\n${forkInterfaceTail}}\n\nexport const tail = 0;\n${keepGone ? "export const gone = 2;\n" : ""}${forkFileTail}`,
});

it("passes a one-line in-place substitution declared by marking the replacing line", () => {
  const root = fixture();
  const path = "packages/contracts/src/settings.ts";
  try {
    // The fork replaces `input: { cwd: props.cwd }` in place; the replacing line carries the
    // marker, and the removed upstream line needs none (RSI-Software/t3code-hyprws#1024).
    stageConflict(
      root,
      path,
      substitutionStages(
        "  input: workspaceFileListing; // fork-hook: upstream-fixes/test-sub\n",
        "",
      ),
    );
    const outcome = executeConflictOutcome(typecheckRunner(), root, path, gateManifest);
    assert.isFalse(isUnresolved(outcome));
    if (isUnresolved(outcome)) return;
    assert.strictEqual(outcome.source, "hook-reapply");
    assert.strictEqual(outcome.conflictClass, "mechanical");
    assert.deepStrictEqual(outcome.reinsertedHooks, [SUBSTITUTION_HOOK]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses an in-place substitution whose replacing line is unmarked", () => {
  const root = fixture();
  const path = "packages/contracts/src/settings.ts";
  try {
    stageConflict(root, path, substitutionStages("  input: workspaceFileListing;\n", ""));
    const outcome = executeConflictOutcome(typecheckRunner(), root, path, gateManifest);
    assert.isTrue(isUnresolved(outcome));
    if (!isUnresolved(outcome)) return;
    assert.include(outcome.reason, "rewrote the same lines");
    assert.include(outcome.reason, "removes base line 3 outside every marked hook");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a removal outside every marked span even with a marked hook elsewhere", () => {
  const root = fixture();
  const path = "packages/contracts/src/settings.ts";
  try {
    // The fork deletes the trailing `gone` line and carries a marked hook far from it. A budget
    // of marked lines would absorb the deletion; the positional check does not.
    stageConflict(
      root,
      path,
      substitutionStages("  forkField: string; // fork-hook: upstream-fixes/test-sub\n", "", false),
    );
    const outcome = executeConflictOutcome(typecheckRunner(), root, path, gateManifest);
    assert.isTrue(isUnresolved(outcome));
    if (!isUnresolved(outcome)) return;
    assert.include(outcome.reason, "removes base line 7 outside every marked hook");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// RSI-Software/t3code-hyprws#1024 phase 2: the seven real seams, marked. Each test stages one
// real seam's conflict — upstream rewrote the seam's upstream line, the fork substituted it in
// place behind the marker the fork tree now carries — and asserts `executeConflictOutcome` lifts
// it as a mechanical hook re-apply. Fragments are trimmed to the seam, so the manifest slice
// given to the executor carries exactly the hooks the fragment's fork side marks.
// ---------------------------------------------------------------------------

/** Stages one marked seam and asserts the walk lifts it, re-inserting the seam's hook. */
const seamLifts = (
  path: string,
  hook: { readonly key: string; readonly anchor: ForkHookAnchor },
  manifest: Record<string, { path: string; anchor: ForkHookAnchor }>,
  stages: { readonly base: string; readonly ours: string; readonly theirs: string },
): void => {
  const root = fixture();
  try {
    stageConflict(root, path, stages);
    const outcome = executeConflictOutcome(typecheckRunner(), root, path, manifest);
    assert.isFalse(isUnresolved(outcome), "unexpectedly unresolved");
    if (isUnresolved(outcome)) return;
    assert.strictEqual(outcome.source, "hook-reapply");
    assert.strictEqual(outcome.conflictClass, "mechanical");
    assert.include(outcome.reinsertedHooks as unknown[], hook.key);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

/** Stages one seam and asserts the walk refuses it with the given cause. */
const seamRefuses = (
  path: string,
  manifest: Record<string, { path: string; anchor: ForkHookAnchor }>,
  stages: { readonly base: string; readonly ours: string; readonly theirs: string },
  cause: string,
): void => {
  const root = fixture();
  try {
    stageConflict(root, path, stages);
    const outcome = executeConflictOutcome(typecheckRunner(), root, path, manifest);
    assert.isTrue(isUnresolved(outcome), "unexpectedly resolved");
    if (!isUnresolved(outcome)) return;
    assert.include(outcome.reason, cause);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

const ROUTE_SCREEN = "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx";
const routeManifest = {
  "workspace-files/mobile-route-ignored-listing-import": {
    path: ROUTE_SCREEN,
    anchor: { kind: "import-block" },
  },
  "workspace-files/mobile-route-ignored-listing-call": {
    path: ROUTE_SCREEN,
    anchor: { kind: "after-decl", symbol: "revealedInspectorRef" },
  },
  "workspace-files/mobile-route-ignored-listing-condition": {
    path: ROUTE_SCREEN,
    anchor: { kind: "after-decl", symbol: "revealedInspectorRef" },
  },
  "workspace-files/mobile-route-ignored-listing-input": {
    path: ROUTE_SCREEN,
    anchor: { kind: "after-decl", symbol: "entriesQuery" },
  },
} as const;

const routeScreenStages = () => ({
  base: 'import { preloadWorkspaceFileContents } from "./preload-workspace-file";\nexport function ThreadFilesTreeScreen(props: ThreadFilesRouteScreenProps) {\n  const revealedInspectorRef = useRef(false);\n  const entriesQuery = useEnvironmentQuery(\n    environmentId !== null && cwd !== null && !fileInspector.supported\n      ? projectEnvironment.listEntries({\n          environmentId,\n          input: { cwd },\n        })\n      : null,\n  );\n}\n',
  // Upstream evolves the same condition line the fork rewires to the ignored listing.
  ours: 'import { preloadWorkspaceFileContents } from "./preload-workspace-file";\nexport function ThreadFilesTreeScreen(props: ThreadFilesRouteScreenProps) {\n  const revealedInspectorRef = useRef(false);\n  const entriesQuery = useEnvironmentQuery(\n    environmentId !== null && cwd !== null && fileInspector.ready\n      ? projectEnvironment.listEntries({\n          environmentId,\n          input: { cwd, follow: true },\n        })\n      : null,\n  );\n}\n',
  theirs:
    'import { useIgnoredWorkspaceFileListing } from "./ignoredWorkspaceFileListing"; // fork-hook: workspace-files/mobile-route-ignored-listing-import\nimport { preloadWorkspaceFileContents } from "./preload-workspace-file";\nexport function ThreadFilesTreeScreen(props: ThreadFilesRouteScreenProps) {\n  const revealedInspectorRef = useRef(false);\n  const workspaceFileListing = useIgnoredWorkspaceFileListing(cwd); // fork-hook: workspace-files/mobile-route-ignored-listing-call\n  const entriesQuery = useEnvironmentQuery(\n    environmentId !== null && workspaceFileListing !== null && !fileInspector.supported // fork-hook: workspace-files/mobile-route-ignored-listing-condition\n      ? projectEnvironment.listEntries({\n          environmentId,\n          input: workspaceFileListing, // fork-hook: workspace-files/mobile-route-ignored-listing-input\n        })\n      : null,\n  );\n}\n',
});

it("lifts the mobile route condition substitution (workspace-files/mobile-route-ignored-listing-condition)", () => {
  seamLifts(
    ROUTE_SCREEN,
    {
      key: "workspace-files/mobile-route-ignored-listing-condition",
      anchor: { kind: "after-decl", symbol: "revealedInspectorRef" },
    },
    routeManifest,
    routeScreenStages(),
  );
});

it("lifts the mobile route input substitution (workspace-files/mobile-route-ignored-listing-input)", () => {
  seamLifts(
    ROUTE_SCREEN,
    {
      key: "workspace-files/mobile-route-ignored-listing-input",
      anchor: { kind: "after-decl", symbol: "entriesQuery" },
    },
    routeManifest,
    routeScreenStages(),
  );
});

it("lifts the mobile inspector input substitution (workspace-files/mobile-inspector-ignored-listing-input)", () => {
  const path = "apps/mobile/src/features/files/thread-file-navigator-pane.tsx";
  seamLifts(
    path,
    {
      key: "workspace-files/mobile-inspector-ignored-listing-input",
      anchor: { kind: "after-decl", symbol: "entriesQuery" },
    },
    {
      "workspace-files/mobile-inspector-ignored-listing-import": {
        path,
        anchor: { kind: "import-block" },
      },
      "workspace-files/mobile-inspector-ignored-listing-call": {
        path,
        anchor: { kind: "after-decl", symbol: "headerScrollEdgeEffects" },
      },
      "workspace-files/mobile-inspector-ignored-listing-input": {
        path,
        anchor: { kind: "after-decl", symbol: "entriesQuery" },
      },
    },
    {
      base: 'import { preloadWorkspaceFileContents } from "./preload-workspace-file";\nexport function ThreadFileNavigatorPane(props: {\n  cwd: string;\n}) {\n  const headerScrollEdgeEffects = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);\n  const entriesQuery = useEnvironmentQuery(\n    projectEnvironment.listEntries({\n      environmentId: props.environmentId,\n      input: { cwd: props.cwd },\n    }),\n  );\n}\n',
      ours: 'import { preloadWorkspaceFileContents } from "./preload-workspace-file";\nexport function ThreadFileNavigatorPane(props: {\n  cwd: string;\n}) {\n  const headerScrollEdgeEffects = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);\n  const entriesQuery = useEnvironmentQuery(\n    projectEnvironment.listEntries({\n      environmentId: props.environmentId,\n      input: { cwd: props.cwd, follow: true },\n    }),\n  );\n}\n',
      theirs:
        'import { useIgnoredWorkspaceFileListing } from "./ignoredWorkspaceFileListing"; // fork-hook: workspace-files/mobile-inspector-ignored-listing-import\nimport { preloadWorkspaceFileContents } from "./preload-workspace-file";\nexport function ThreadFileNavigatorPane(props: {\n  cwd: string;\n}) {\n  const headerScrollEdgeEffects = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);\n  const workspaceFileListing = useIgnoredWorkspaceFileListing(props.cwd); // fork-hook: workspace-files/mobile-inspector-ignored-listing-call\n  const entriesQuery = useEnvironmentQuery(\n    projectEnvironment.listEntries({\n      environmentId: props.environmentId,\n      input: workspaceFileListing, // fork-hook: workspace-files/mobile-inspector-ignored-listing-input\n    }),\n  );\n}\n',
    },
  );
});

it("lifts the workspace entries list-result substitution (workspace-files/workspace-entries-list-ignored-result)", () => {
  const path = "apps/server/src/workspace/WorkspaceEntries.ts";
  const body =
    '        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;\n        return yield* searchIndex.list();\n      }).pipe(\n        Effect.provide(workspaceSearchIndexes.get("paths")),\n      );\n';
  seamLifts(
    path,
    {
      key: "workspace-files/workspace-entries-list-ignored-result",
      anchor: { kind: "after-decl", symbol: "list" },
    },
    {
      "workspace-files/workspace-entries-list-ignored-result": {
        path,
        anchor: { kind: "after-decl", symbol: "list" },
      },
    },
    {
      base:
        'import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";\nexport const make = Effect.gen(function* () {\n  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(\n    function* (input) {\n      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);\n      return yield* Effect.gen(function* () {\n' +
        body +
        "    },\n  );\n});\n",
      ours:
        'import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";\nexport const make = Effect.gen(function* () {\n  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(\n    function* (input) {\n      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);\n      const listed = yield* Effect.gen(function* () {\n' +
        body +
        "    },\n  );\n});\n",
      theirs:
        'import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";\nexport const make = Effect.gen(function* () {\n  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(\n    function* (input) {\n      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);\n      const result = yield* Effect.gen(function* () { // fork-hook: workspace-files/workspace-entries-list-ignored-result\n' +
        body +
        "      return yield* WorkspaceEntriesFork.withIgnoredWorkspaceFiles({\n        vcsDrivers,\n        cwd: normalizedCwd,\n        includeIgnored: input.includeIgnored === true,\n        result,\n      }); // fork-hook: workspace-files/workspace-entries-list-ignored\n    },\n  );\n});\n",
    },
  );
});

it("lifts the file browser listing-call substitution already inside its marked statement (workspace-files/file-browser-ignored-listing-call)", () => {
  const path = "apps/web/src/components/files/FileBrowserPanel.tsx";
  seamLifts(
    path,
    {
      key: "workspace-files/file-browser-ignored-listing-call",
      anchor: { kind: "after-call", symbol: "useComposerHandleContext" },
    },
    {
      "workspace-files/file-browser-ignored-listing-call": {
        path,
        anchor: { kind: "after-call", symbol: "useComposerHandleContext" },
      },
    },
    {
      base: 'import { useProjectEntriesQuery } from "./projectFilesQueryState";\nexport default function FileBrowserPanel({ environmentId, cwd }: FileBrowserPanelProps) {\n  const composerRef = useComposerHandleContext();\n  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);\n  return entriesQuery;\n}\n',
      ours: 'import { useProjectEntriesQuery } from "./projectFilesQueryState";\nexport default function FileBrowserPanel({ environmentId, cwd }: FileBrowserPanelProps) {\n  const composerRef = useComposerHandleContext();\n  const entriesQuery = useProjectEntriesQuery(environmentId, cwd, { live: true });\n  return entriesQuery;\n}\n',
      theirs:
        'import { ShowIgnoredFilesButton, useIgnoredWorkspaceFileListing } from "./FileBrowserPanel.fork"; // fork-hook: workspace-files/file-browser-ignored-listing\nexport default function FileBrowserPanel({ environmentId, cwd }: FileBrowserPanelProps) {\n  const composerRef = useComposerHandleContext();\n  const { entriesQuery, showIgnoredFiles, updateClientSettings, ignoredGitStatus } =\n    useIgnoredWorkspaceFileListing(environmentId, cwd); // fork-hook: workspace-files/file-browser-ignored-listing-call\n  return entriesQuery;\n}\n',
    },
  );
});

it("refuses the settings-overrides env-mode-wire seam on its unmarked gap additions (worktrunk-hooks/settings-overrides-env-mode-wire)", () => {
  const path = "packages/contracts/src/settings.ts";
  seamRefuses(
    path,
    {
      "worktrunk-hooks/settings-overrides-env-mode-wire": {
        path,
        anchor: { kind: "after-decl", symbol: "QuitConfirmationModeSetting" },
      },
    },
    {
      base: "const QuitConfirmationModeSetting = Schema.Union([QuitConfirmationMode, LegacyConfirmQuit]);\nexport const ProjectSettingsOverrides = Schema.Struct({\n  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),\n  enableLegacyTokenStreaming: Schema.optionalKey(Schema.Boolean),\n} satisfies Record<ProjectScopedServerSettingKey, unknown>);\nexport type ProjectSettingsOverrides = typeof ProjectSettingsOverrides.Type;\n",
      ours: "const QuitConfirmationModeSetting = Schema.Union([QuitConfirmationMode, LegacyConfirmQuit]);\nexport const ProjectSettingsOverrides = Schema.Struct({\n  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),\n  enableLegacyTokenStreaming: Schema.optionalKey(Schema.Boolean),\n} satisfies Record<ProjectScopedServerSettingKey, unknown> & Record<string, unknown>);\nexport type ProjectSettingsOverrides = typeof ProjectSettingsOverrides.Type;\n",
      theirs:
        "const QuitConfirmationModeSetting = Schema.Union([QuitConfirmationMode, LegacyConfirmQuit]);\nexport const ProjectSettingsOverrides = Schema.Struct({\n  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),\n  enableLegacyTokenStreaming: Schema.optionalKey(Schema.Boolean),\n} satisfies Record<ProjectScopedServerSettingKey, unknown> & { // fork-hook: worktrunk-hooks/settings-overrides-env-mode-wire\n  // Fork: the `...Fork` sibling is deliberately NOT a standalone scopable\n  // key — it only travels with the wire slot it belongs to.\n  defaultThreadEnvModeFork?: unknown;\n});\nexport type ProjectSettingsOverrides = typeof ProjectSettingsOverrides.Type;\n",
    },
    "adds lines beyond its marked hooks",
  );
});

it("lifts the settings-restore env-mode-wire substitution (worktrunk-hooks/settings-restore-env-mode-wire)", () => {
  const path = "apps/web/src/components/settings/SettingsPanels.tsx";
  seamLifts(
    path,
    {
      key: "worktrunk-hooks/settings-restore-env-mode-wire",
      anchor: { kind: "after-decl", symbol: "useSettingsRestore" },
    },
    {
      "worktrunk-hooks/settings-restore-env-mode-wire": {
        path,
        anchor: { kind: "after-decl", symbol: "useSettingsRestore" },
      },
    },
    {
      base: 'export function useSettingsRestore(onRestored?: () => void) {\n  const labels = [\n    ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),\n    ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode\n      ? ["New thread mode"]\n      : []),\n  ];\n  return labels;\n}\n',
      ours: 'export function useSettingsRestore(onRestored?: () => void) {\n  const labels = [\n    ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),\n    ...(settings.defaultThreadEnvMode !== undefined\n      ? ["New thread mode"]\n      : []),\n  ];\n  return labels;\n}\n',
      theirs:
        'export function useSettingsRestore(onRestored?: () => void) {\n  const labels = [\n    ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),\n    ...(fromWireThreadEnvModeFields(settings) !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode // fork-hook: worktrunk-hooks/settings-restore-env-mode-wire\n      ? ["New thread mode"]\n      : []),\n  ];\n  return labels;\n}\n',
    },
  );
});

it("lifts the decider env-mode-wire substitution (worktrunk-hooks/decider-thread-env-mode-wire)", () => {
  const path = "apps/server/src/orchestration/decider.ts";
  seamLifts(
    path,
    {
      key: "worktrunk-hooks/decider-thread-env-mode-wire",
      anchor: { kind: "after-decl", symbol: "decideOrchestrationCommand" },
    },
    {
      "worktrunk-hooks/decider-thread-env-mode-wire": {
        path,
        anchor: { kind: "after-decl", symbol: "decideOrchestrationCommand" },
      },
    },
    {
      base: 'export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(\n  function* (command) {\n    if (command.type !== "project.meta-update") {\n      return yield* refusal;\n    }\n    return {\n      ...(command.title !== undefined ? { title: command.title } : {}),\n      ...(command.defaultThreadEnvMode !== undefined\n        ? { defaultThreadEnvMode: command.defaultThreadEnvMode }\n        : {}),\n    };\n  },\n);\n',
      ours: 'export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(\n  function* (command) {\n    if (command.type !== "project.meta-update") {\n      return yield* refusal;\n    }\n    return {\n      ...(command.title !== undefined ? { title: command.title } : {}),\n      ...(command.defaultThreadEnvMode !== undefined\n        ? { defaultThreadEnvMode: command.defaultThreadEnvMode, locked: true }\n        : {}),\n    };\n  },\n);\n',
      theirs:
        'export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(\n  function* (command) {\n    if (command.type !== "project.meta-update") {\n      return yield* refusal;\n    }\n    return {\n      ...(command.title !== undefined ? { title: command.title } : {}),\n      ...(command.defaultThreadEnvMode !== undefined\n        ? { defaultThreadEnvMode: fromWireThreadEnvModeFields(command) } // fork-hook: worktrunk-hooks/decider-thread-env-mode-wire\n        : {}),\n    };\n  },\n);\n',
    },
  );
});

// ---------------------------------------------------------------------------
// RSI-Software/t3code-hyprws#1030: the gate's manifest comes from the tip module, but the
// replayed commit's blob predates the commit that marked its seam. The fork tip's blob becomes
// the second input: its declarations are located in the replayed text, judged there, and the
// overlay is judgement only — the marker comment never reaches the resolved text.
// ---------------------------------------------------------------------------

/** Commit `contents` for `path` as a detached tip commit; returns the ref the gate reads. */
const stageTip = (root: string, path: string, contents: string): string => {
  const identity = {
    ...process.env,
    GIT_AUTHOR_NAME: "tip",
    GIT_AUTHOR_EMAIL: "tip@example.test",
    GIT_COMMITTER_NAME: "tip",
    GIT_COMMITTER_EMAIL: "tip@example.test",
  };
  const blob = NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: contents,
  })
    .toString()
    .trim();
  const mktree = (input: string): string =>
    NodeChildProcess.execFileSync("git", ["mktree"], { cwd: root, input }).toString().trim();
  const segments = path.split("/");
  let tree = mktree(`100644 blob ${blob}\t${segments[segments.length - 1]}\n`);
  for (let index = segments.length - 2; index >= 0; index -= 1)
    tree = mktree(`040000 tree ${tree}\t${segments[index]}\n`);
  return NodeChildProcess.execFileSync("git", ["commit-tree", tree], {
    cwd: root,
    input: "tip\n",
    env: identity,
  })
    .toString()
    .trim();
};

/** Remove the trailing line-marker comment the fork tip carries and the replayed commit does not. */
const stripLineMarkers = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.replace(/ \/\/ fork-hook: [\w/-]+$/, ""))
    .join("\n");

const ROUTE_KEYS = Object.keys(routeManifest);

it("lifts a seam the replayed fork blob predates by reading the fork tip's markers", () => {
  const path = ROUTE_SCREEN;
  const marked = routeScreenStages().theirs;
  const stages = { ...routeScreenStages(), theirs: stripLineMarkers(marked) };
  // Without the tip: the fork side is hook-shaped but unmarked at this commit, so the gate refuses.
  const bareRoot = fixture();
  try {
    stageConflict(bareRoot, path, stages);
    const bare = executeConflictOutcome(typecheckRunner(), bareRoot, path, routeManifest);
    assert.isTrue(isUnresolved(bare), "expected the unmarked blob alone to refuse");
    if (!isUnresolved(bare)) return;
    assert.include(bare.reason, "outside every marked hook");
  } finally {
    NodeFS.rmSync(bareRoot, { recursive: true, force: true });
  }
  // With the tip: the same fork blob lifts, one re-insertion per declared hook.
  const root = fixture();
  try {
    stageConflict(root, path, stages);
    const tipRef = stageTip(root, path, marked);
    const outcome = executeConflictOutcome(
      typecheckRunner(),
      root,
      path,
      routeManifest,
      true,
      tipRef,
    );
    assert.isFalse(
      isUnresolved(outcome),
      `expected the tip's markers to lift the seam: ${isUnresolved(outcome) ? outcome.reason : ""}`,
    );
    if (isUnresolved(outcome)) return;
    assert.strictEqual(outcome.source, "hook-reapply");
    assert.deepStrictEqual([...(outcome.reinsertedHooks ?? [])].sort(), [...ROUTE_KEYS].sort());
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("resolves an already-marked fork blob identically with and without the tip blob", () => {
  const path = ROUTE_SCREEN;
  const marked = routeScreenStages().theirs;
  const run = (withTip: boolean) => {
    const root = fixture();
    try {
      stageConflict(root, path, routeScreenStages());
      const tipRef = withTip ? stageTip(root, path, marked) : undefined;
      const outcome = executeConflictOutcome(
        typecheckRunner(),
        root,
        path,
        routeManifest,
        true,
        tipRef,
      );
      assert.isFalse(isUnresolved(outcome));
      if (isUnresolved(outcome)) return null;
      return {
        reinsertedHooks: outcome.reinsertedHooks,
        text: NodeFS.readFileSync(NodePath.join(root, path), "utf8"),
      };
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  };
  assert.deepStrictEqual(run(true), run(false));
});

it("refuses an ambiguous tip declaration and names the key", () => {
  const path = "packages/contracts/src/settings.ts";
  const root = fixture();
  try {
    // The whole statement, not just its `});` closer, occurs twice in this commit's fork text.
    const block = "export const tail = workspaceFileListing({\n  a: 1,\n});";
    const theirs = `export interface ServerSettingsPatch {\n  rename: string;\n}\n\n${block}\n${block}\n`;
    stageConflict(root, path, {
      base: "export interface ServerSettingsPatch {\n  rename: string;\n  input: { cwd: props.cwd };\n}\n",
      ours: "export interface ServerSettingsPatch {\n  name: string;\n}\n",
      theirs,
    });
    const tipRef = stageTip(
      root,
      path,
      theirs.replace(
        "});\nexport const tail = workspaceFileListing({\n  a: 1,\n});\n",
        "}); // fork-hook: upstream-fixes/test-sub\nexport const tail = workspaceFileListing({\n  a: 1,\n});\n",
      ),
    );
    const outcome = executeConflictOutcome(
      typecheckRunner(),
      root,
      path,
      gateManifest,
      true,
      tipRef,
    );
    assert.isTrue(isUnresolved(outcome), "expected the ambiguous declaration to refuse");
    if (!isUnresolved(outcome)) return;
    assert.include(outcome.reason, "`upstream-fixes/test-sub`");
    assert.include(outcome.reason, "fork tip");
    assert.include(outcome.reason, "matches several lines");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("skips an absent tip declaration, so the seam declines for its own reason", () => {
  const path = ROUTE_SCREEN;
  const root = fixture();
  try {
    // The tip marks a seam renamed away from what this commit carries: no bare line matches.
    const renamed = routeScreenStages().theirs.replaceAll("workspaceFileListing", "otherListing");
    stageConflict(root, path, {
      ...routeScreenStages(),
      theirs: stripLineMarkers(routeScreenStages().theirs),
    });
    const tipRef = stageTip(root, path, renamed);
    const outcome = executeConflictOutcome(
      typecheckRunner(),
      root,
      path,
      routeManifest,
      true,
      tipRef,
    );
    assert.isTrue(isUnresolved(outcome), "expected the absent declaration to skip");
    if (!isUnresolved(outcome)) return;
    assert.include(outcome.reason, "outside every marked hook");
    assert.include(outcome.reason, "keep-both declined");
    // Absent is visible: the refusal names every key the tip declared but this commit lacks.
    for (const key of ROUTE_KEYS) assert.include(outcome.reason, `\`${key}\``);
    assert.include(outcome.reason, "the fork tip declares");
    assert.include(outcome.reason, "no matching lines exist in this commit");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("the resolved text carries no marker the replayed fork blob did not carry", () => {
  const path = "packages/contracts/src/settings.ts";
  const root = fixture();
  try {
    stageConflict(root, path, substitutionStages("  input: workspaceFileListing;\n", ""));
    const tipRef = stageTip(
      root,
      path,
      substitutionStages(
        "  input: workspaceFileListing; // fork-hook: upstream-fixes/test-sub\n",
        "",
      ).theirs,
    );
    const outcome = executeConflictOutcome(
      typecheckRunner(),
      root,
      path,
      gateManifest,
      true,
      tipRef,
    );
    assert.isFalse(isUnresolved(outcome));
    if (isUnresolved(outcome)) return;
    const resolved = NodeFS.readFileSync(NodePath.join(root, path), "utf8");
    // The overlay is judgement only: at this commit the marker does not yet exist.
    assert.isFalse(resolved.includes("fork-hook:"), "an overlaid marker reached the resolved text");
    assert.include(resolved, "input: workspaceFileListing;");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("locates a closing-delimiter marker by its whole statement, not the marked line", () => {
  const path = "packages/contracts/src/settings.ts";
  const root = fixture();
  try {
    // The tip's marker sits on `}),`, which also occurs in the unchanged `pre` statement; the
    // marked line alone matches twice, the whole statement exactly once.
    const forkBlock = "  forkExtra: withDefaults({\n    x: 1,\n  }),";
    const tail =
      "export const tail = 0;\nexport const pre = fn({\n  z: 3,\n});\nexport const gone = 2;\n";
    stageConflict(root, path, {
      base: `export interface ServerSettingsPatch {\n  rename: string;\n  input: { cwd: props.cwd };\n}\n\n${tail}`,
      ours: `export interface ServerSettingsPatch {\n  name: string;\n  mount: boolean;\n}\n\n${tail}`,
      theirs: `export interface ServerSettingsPatch {\n  rename: string;\n${forkBlock}\n}\n\n${tail}`,
    });
    const tipRef = stageTip(
      root,
      path,
      `export interface ServerSettingsPatch {\n  rename: string;\n${forkBlock.replace(
        "  }),",
        "  }), // fork-hook: upstream-fixes/test-sub",
      )}\n}\n\n${tail}`,
    );
    const outcome = executeConflictOutcome(
      typecheckRunner(),
      root,
      path,
      gateManifest,
      true,
      tipRef,
    );
    assert.isFalse(isUnresolved(outcome), "expected the whole-statement match to locate the span");
    if (isUnresolved(outcome)) return;
    assert.strictEqual(outcome.source, "hook-reapply");
    assert.deepStrictEqual(outcome.reinsertedHooks, [SUBSTITUTION_HOOK]);
    const resolved = NodeFS.readFileSync(NodePath.join(root, path), "utf8");
    assert.include(resolved, "forkExtra: withDefaults({");
    assert.isFalse(resolved.includes("fork-hook:"), "an overlaid marker reached the resolved text");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
