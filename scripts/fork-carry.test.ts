import { assert, it } from "@effect/vitest";

import { renderStopComment } from "./fork-carry.ts";

it("hands the stop surface over without the runner's dead resume line", () => {
  const comment = renderStopComment(
    [
      "/tmp/fork-sync-report-abc/report.json",
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
