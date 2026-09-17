import { assert, it } from "@effect/vitest";

import { extractStopSurface, renderStopComment } from "./fork-carry.ts";

it("hands the stop surface over without the runner's dead resume line", () => {
  const comment = renderStopComment(
    [
      "/tmp/fork-sync-report-abc/report.json",
      "target rule: explicit --target: v1.2.3@abc",
      "## Gate 4 decision surface",
      "Stop (conflict). The outcome executor declined `apps/web/src/window.ts`.",
      "report: /tmp/fork-sync-report-abc/report.json",
      "resume: node scripts/fork-sync.ts unblock-auto --resume --report /tmp/fork-sync-report-abc/report.json",
      "",
    ].join("\n"),
    "v1.2.3",
  );
  assert.include(comment, "## Gate 4 decision surface");
  assert.include(comment, "Stop (conflict). The outcome executor declined");
  // Neither the retired resume line nor a runner-local report path survives the handover.
  assert.notInclude(comment, "--resume --report");
  assert.notInclude(comment, "report: /tmp/fork-sync-report-abc");
  assert.include(comment, "node scripts/fork-sync.ts unblock-auto --target v1.2.3");
});

it("keeps the walk's own stop surface and drops install and rebase-progress noise", () => {
  const log = [
    "Setup Vite+ cache hit",
    "target rule: explicit --target: v1.2.3@abc",
    "Scope: all 16 workspace projects",
    "Lockfile is up to date, resolution step is skipped",
    "Progress: resolved 1868, reused 1837, downloaded 0, added 1868, done",
    "Packages: +1868",
    "++++++++++++++++++++++++++++++++++++++++++++++++++++",
    ".../sharp@0.34.5/node_modules/sharp install: Done",
    "devDependencies:",
    "+ typescript 7.0.2",
    ". prepare: Done",
    "Done in 13s using pnpm v11.10.0",
    "Rebasing (1/300)",
    "Auto-merging apps/web/src/a.tsx",
    "CONFLICT (content): Merge conflict in apps/web/src/a.tsx",
    "error: could not apply e80dd9efb... refactor(web): centralize thread route navigation",
    "hint: Resolve all conflicts manually, mark them as resolved with",
    "Recorded preimage for 'apps/web/src/a.tsx'",
    "warning: pending decision row: record does not match; retrying the refs/fork/churn lease once",
    "churn row write failed; the stop reason is unchanged: no row",
    "/tmp/fork-sync-report-abc/report.json",
    "Stop (conflict). The outcome executor declined `apps/web/src/a.tsx`.",
    "report: /tmp/fork-sync-report-abc/report.json",
    "## Walk",
    "- target: `v1.2.3@abc`",
    "- stop (conflict): declined",
    "",
  ].join("\n");
  const surface = extractStopSurface(log);
  // The walk's own verdicts survive verbatim.
  assert.include(surface, "target rule: explicit --target: v1.2.3@abc");
  assert.include(surface, "CONFLICT (content): Merge conflict in apps/web/src/a.tsx");
  assert.include(
    surface,
    "error: could not apply e80dd9efb... refactor(web): centralize thread route navigation",
  );
  assert.include(surface, "Stop (conflict). The outcome executor declined");
  assert.include(surface, "## Walk");
  assert.include(surface, "- stop (conflict): declined");
  // Install and rebase-progress noise is dropped.
  for (const noise of [
    "Setup Vite+ cache hit",
    "Scope: all 16 workspace projects",
    "Lockfile is up to date",
    "Progress: resolved 1868",
    "Packages: +1868",
    "++++",
    "sharp install: Done",
    "devDependencies:",
    "+ typescript 7.0.2",
    ". prepare: Done",
    "Done in 13s",
    "Rebasing (1/300)",
    "Auto-merging apps/web/src/a.tsx",
    "hint: Resolve all conflicts",
    "Recorded preimage",
    "pending decision row",
    "churn row write failed",
    "report: /tmp/fork-sync-report-abc",
  ])
    assert.notInclude(surface, noise);
});

it("keeps nothing when the walk never reached its target rule", () => {
  assert.strictEqual(
    extractStopSurface(["Setup Vite+ cache hit", "install failed"].join("\n")),
    "",
  );
});
