import * as Effect from "effect/Effect";
import type {
  IssueTarget,
  IssueTrackerError,
  TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";

import type { LinearApi, LinearIssue } from "./LinearApi.ts";

/** A chat chip's read: the issue's title and state, batched with every other chip's. */
export const linearIssueSummaryFork = (
  linear: LinearApi["Service"],
  helpers: {
    readonly requireIdentifier: (
      operation: string,
      key: string,
    ) => Effect.Effect<string, IssueTrackerError>;
    readonly notFound: (operation: string) => IssueTrackerError;
    readonly toSummary: (issue: LinearIssue) => TrackerIssueSummary;
  },
) =>
  Effect.fn("LinearIssueTracker.getIssueSummaryFork")(function* (input: IssueTarget) {
    const identifier = yield* helpers.requireIdentifier("getIssue", input.key);
    const issue = yield* linear.getIssueSummaryFork(identifier);
    if (issue === null) return yield* helpers.notFound("getIssue");
    return helpers.toSummary(issue);
  });
