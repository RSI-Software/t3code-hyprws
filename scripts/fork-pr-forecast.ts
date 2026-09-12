#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - The PR check is standalone Git and GitHub plumbing.

import {
  forecastPullRequest,
  PULL_REQUEST_FORECAST_MARKER,
  renderPullRequestForecast,
} from "./fork-forecast.ts";
import { runCommandText } from "./lib/fork-command.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";

const postComment = (root: string, pullRequest: string, body: string): void => {
  const comments = JSON.parse(
    runCommandText(
      "gh",
      ["api", `repos/${FORK_REPOSITORY}/issues/${pullRequest}/comments`, "--paginate"],
      { cwd: root },
    ),
  ) as ReadonlyArray<{ readonly id: number; readonly body: string }>;
  const existing = comments.findLast((comment) =>
    comment.body.includes(PULL_REQUEST_FORECAST_MARKER),
  );
  const args =
    existing === undefined
      ? ["api", "--method", "POST", `repos/${FORK_REPOSITORY}/issues/${pullRequest}/comments`]
      : ["api", "--method", "PATCH", `repos/${FORK_REPOSITORY}/issues/comments/${existing.id}`];
  runCommandText("gh", [...args, "--raw-field", `body=${body}`], { cwd: root });
};

const postNeutralCheck = (root: string, head: string): void => {
  runCommandText(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${FORK_REPOSITORY}/check-runs`,
      "--raw-field",
      "name=Fork conflict forecast",
      "--raw-field",
      `head_sha=${head}`,
      "--raw-field",
      "status=completed",
      "--raw-field",
      "conclusion=neutral",
    ],
    { cwd: root },
  );
};

export const run = (root: string, pullRequest: string, head: string): void => {
  const row = forecastPullRequest(root, head);
  const body = renderPullRequestForecast(row);
  postComment(root, pullRequest, body);
  postNeutralCheck(root, head);
  process.stdout.write(`forecast comment and neutral check on pull request ${pullRequest}\n`);
};

if (import.meta.main) {
  const [pullRequest, head] = process.argv.slice(2);
  if (pullRequest === undefined || head === undefined) {
    throw new Error("usage: fork-pr-forecast.ts <pull-request-number> <head-sha>");
  }
  run(process.cwd(), pullRequest, head);
}
