#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - The PR check is standalone Git and GitHub plumbing.

import {
  forecastPullRequest,
  type MainForecast,
  PULL_REQUEST_FORECAST_MARKER,
  renderPullRequestForecast,
} from "./fork-forecast.ts";
import { runCommandText } from "./lib/fork-command.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";

export interface PullRequestComment {
  readonly id: number;
  readonly body: string;
  readonly user?: { readonly type?: string } | null;
}

/**
 * The bot's own comment, or none. Ownership comes from the API's author type, never the
 * body: a human quoting the marker is never edited or deleted.
 */
export const botForecastComment = (comments: ReadonlyArray<PullRequestComment>): number | null =>
  comments.findLast(
    (comment) =>
      comment.user?.type === "Bot" && comment.body.includes(PULL_REQUEST_FORECAST_MARKER),
  )?.id ?? null;

/** What a forecast result does to the pull request's comment. */
export type ForecastPublication =
  | { readonly kind: "upsert"; readonly body: string }
  | { readonly kind: "delete"; readonly warning: string | null };

/**
 * Conflicts publish one comment, a partial walk as an explicit lower bound. No rows
 * removes a stale comment rather than leaving an obsolete claim, and warns when unusable.
 */
export const publication = (row: MainForecast): ForecastPublication => {
  const body = renderPullRequestForecast(row);
  if (body !== null) return { kind: "upsert", body };
  return {
    kind: "delete",
    warning: row.complete
      ? null
      : "forecast was partial; no clean claim is published and any stale comment is removed",
  };
};

export const run = (root: string, pullRequest: string, head: string): void => {
  const row = forecastPullRequest(root, head);
  const existing = botForecastComment(
    JSON.parse(
      runCommandText(
        "gh",
        ["api", `repos/${FORK_REPOSITORY}/issues/${pullRequest}/comments`, "--paginate"],
        { cwd: root },
      ),
    ) as ReadonlyArray<PullRequestComment>,
  );
  const decided = publication(row);
  if (decided.kind === "delete") {
    if (existing !== null) {
      runCommandText(
        "gh",
        ["api", "--method", "DELETE", `repos/${FORK_REPOSITORY}/issues/comments/${existing}`],
        { cwd: root },
      );
    }
    if (decided.warning !== null) {
      process.stdout.write(`::warning::Pull request ${pullRequest}: ${decided.warning}\n`);
    } else {
      process.stdout.write(`no conflicts on pull request ${pullRequest}\n`);
    }
    return;
  }
  const args =
    existing === null
      ? ["api", "--method", "POST", `repos/${FORK_REPOSITORY}/issues/${pullRequest}/comments`]
      : ["api", "--method", "PATCH", `repos/${FORK_REPOSITORY}/issues/comments/${existing}`];
  runCommandText("gh", [...args, "--raw-field", `body=${decided.body}`], { cwd: root });
  process.stdout.write(`forecast comment on pull request ${pullRequest}\n`);
};

if (import.meta.main) {
  const [pullRequest, head] = process.argv.slice(2);
  if (pullRequest === undefined || head === undefined) {
    throw new Error("usage: fork-pr-forecast.ts <pull-request-number> <head-sha>");
  }
  run(process.cwd(), pullRequest, head);
}
