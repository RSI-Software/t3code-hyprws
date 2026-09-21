#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - The PR check is standalone Git and GitHub plumbing.

import {
  forecastPullRequest,
  PULL_REQUEST_FORECAST_MARKER,
  renderPullRequestForecast,
} from "./fork-forecast.ts";
import { runCommandText } from "./lib/fork-command.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";

const existingComment = (root: string, pullRequest: string): number | null => {
  const comments = JSON.parse(
    runCommandText(
      "gh",
      ["api", `repos/${FORK_REPOSITORY}/issues/${pullRequest}/comments`, "--paginate"],
      { cwd: root },
    ),
  ) as ReadonlyArray<{ readonly id: number; readonly body: string }>;
  return (
    comments.findLast((comment) => comment.body.includes(PULL_REQUEST_FORECAST_MARKER))?.id ?? null
  );
};

/**
 * A conflicting pull request carries one sticky comment; a clean one carries none and
 * loses any comment a previous push left. An unusable forecast publishes nothing and
 * says so in the workflow log (RSI-Software/t3code-hyprws#1143).
 */
export const run = (root: string, pullRequest: string, head: string): void => {
  const row = forecastPullRequest(root, head);
  const body = renderPullRequestForecast(row);
  const existing = existingComment(root, pullRequest);
  if (body === null && !row.complete) {
    process.stdout.write(
      `::warning::Fork conflict forecast for pull request ${pullRequest} was partial; no comment published\n`,
    );
    return;
  }
  if (body === null) {
    if (existing !== null) {
      runCommandText(
        "gh",
        ["api", "--method", "DELETE", `repos/${FORK_REPOSITORY}/issues/comments/${existing}`],
        { cwd: root },
      );
    }
    process.stdout.write(`no conflicts on pull request ${pullRequest}\n`);
    return;
  }
  const args =
    existing === null
      ? ["api", "--method", "POST", `repos/${FORK_REPOSITORY}/issues/${pullRequest}/comments`]
      : ["api", "--method", "PATCH", `repos/${FORK_REPOSITORY}/issues/comments/${existing}`];
  runCommandText("gh", [...args, "--raw-field", `body=${body}`], { cwd: root });
  process.stdout.write(`forecast comment on pull request ${pullRequest}\n`);
};

if (import.meta.main) {
  const [pullRequest, head] = process.argv.slice(2);
  if (pullRequest === undefined || head === undefined) {
    throw new Error("usage: fork-pr-forecast.ts <pull-request-number> <head-sha>");
  }
  run(process.cwd(), pullRequest, head);
}
