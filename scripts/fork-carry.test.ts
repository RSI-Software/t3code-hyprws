import { assert, it } from "@effect/vitest";

import { renderStopComment } from "./fork-carry.ts";

it("hands the stop surface over without the runner's dead resume line", () => {
  const comment = renderStopComment(
    [
      "/tmp/fork-sync-report-abc/report.json",
      "## Gate 4 decision surface",
      "Stop. Obtain every decision and an explicit go.",
      "resume: node scripts/fork-sync.ts unblock-auto --resume --report /tmp/fork-sync-report-abc/report.json",
      "",
    ].join("\n"),
    "v1.2.3",
  );
  assert.include(comment, "## Gate 4 decision surface");
  assert.include(comment, "Stop. Obtain every decision and an explicit go.");
  assert.notInclude(comment, "--resume --report");
  assert.include(comment, "node scripts/fork-sync.ts unblock-auto --target v1.2.3");
});
