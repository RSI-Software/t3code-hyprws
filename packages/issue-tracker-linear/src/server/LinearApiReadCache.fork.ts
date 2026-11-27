/**
 * Linear reads shared across every client, project and remount. Clients reread an issue each time
 * a view of it mounts, and every read spends the account's hourly request quota.
 */
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import type { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";

import type { LinearApi, LinearIssue } from "./LinearApi.ts";

type Api = LinearApi["Service"];
type Write = "createIssue" | "updateIssue" | "createComment" | "createReaction" | "deleteReaction";

/** One issue without its conversation; null when Linear has none by that identifier. */
export type GetIssueSummaryFork = (
  identifier: string,
) => Effect.Effect<LinearIssue | null, IssueTrackerError>;

const TIME_TO_LIVE = "3 minutes";
// Every chip in a view mounts at once and asks for its own issue; one Linear call answers them.
const SUMMARY_BATCH_WINDOW = "20 millis";
const SUMMARY_BATCH_SIZE = 100;

interface SummaryRequest extends Request.Request<LinearIssue | null, IssueTrackerError> {
  readonly identifier: string;
}
const SummaryRequest = Request.of<SummaryRequest>();

export const make = Effect.fn("LinearApiReadCache.make")(function* (
  api: Pick<Api, "viewer" | "getIssue" | "listIssues" | Write>,
  storedToken: (operation: string) => Effect.Effect<string, IssueTrackerError>,
) {
  const timeToLive = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isSuccess(exit) ? TIME_TO_LIVE : 0;
  // Keyed by the token itself, so a new key in Settings never reads another account's answer.
  const viewers = yield* Cache.makeWith((token: string) => api.viewer(token), {
    capacity: 16,
    timeToLive,
  });
  const issues = yield* Cache.makeWith(
    (key: string) => {
      const [, , identifier = "", comments = "0"] = key.split("\u0000");
      return api.getIssue(identifier, Number(comments));
    },
    { capacity: 500, timeToLive },
  );
  const summaryResolver = RequestResolver.make<SummaryRequest>((entries) =>
    api
      .listIssues({
        filter: { id: { in: entries.map((entry) => entry.request.identifier) } },
        first: entries.length,
        orderBy: "updatedAt",
      })
      .pipe(
        Effect.map(({ nodes }) => {
          const byIdentifier = new Map(nodes.map((node) => [node.identifier.toUpperCase(), node]));
          for (const entry of entries) {
            const issue = byIdentifier.get(entry.request.identifier.toUpperCase()) ?? null;
            entry.completeUnsafe(Exit.succeed(issue));
          }
        }),
      ),
  ).pipe(
    RequestResolver.setDelay(SUMMARY_BATCH_WINDOW),
    RequestResolver.batchN(SUMMARY_BATCH_SIZE),
  );
  const summaries = yield* Cache.makeWith(
    (key: string) =>
      Effect.request(SummaryRequest({ identifier: key.split("\u0000")[2] ?? "" }), summaryResolver),
    { capacity: 1000, timeToLive },
  );
  // A read already in flight when a write lands keys the old generation, so it cannot refill.
  let generation = 0;
  const invalidate = Effect.suspend(() => {
    generation += 1;
    return Effect.andThen(Cache.invalidateAll(issues), Cache.invalidateAll(summaries));
  });
  const invalidating =
    <Args extends ReadonlyArray<unknown>, A>(
      write: (...args: Args) => Effect.Effect<A, IssueTrackerError>,
    ) =>
    (...args: Args) =>
      write(...args).pipe(Effect.ensuring(invalidate));

  const getIssueSummaryFork: GetIssueSummaryFork = (identifier) =>
    Effect.flatMap(storedToken("getIssueSummary"), (token) =>
      Cache.get(summaries, [generation, token, identifier].join("\u0000")),
    );
  // Partial only so it can spread over the upstream properties; TS2783 refuses a required override.
  const overrides: Partial<Pick<Api, "viewer" | "getIssue" | Write>> = {
    viewer: (token?: string) =>
      Effect.flatMap(token === undefined ? storedToken("viewer") : Effect.succeed(token), (key) =>
        Cache.get(viewers, key),
      ),
    getIssue: (identifier: string, comments: number) =>
      Effect.flatMap(storedToken("getIssue"), (token) =>
        Cache.get(issues, [generation, token, identifier, comments].join("\u0000")),
      ),
    createIssue: invalidating(api.createIssue),
    updateIssue: invalidating(api.updateIssue),
    createComment: invalidating(api.createComment),
    createReaction: invalidating(api.createReaction),
    deleteReaction: invalidating(api.deleteReaction),
  };
  return { ...overrides, getIssueSummaryFork };
});
