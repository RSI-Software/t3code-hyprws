/**
 * Linear reads shared across every client, project and remount. Clients reread an issue each time
 * a view of it mounts, and every read spends the account's hourly request quota.
 */
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";

import type { LinearApi } from "./LinearApi.ts";

type Api = LinearApi["Service"];
type Write = "createIssue" | "updateIssue" | "createComment" | "createReaction" | "deleteReaction";

const TIME_TO_LIVE = "3 minutes";

export const make = Effect.fn("LinearApiReadCache.make")(function* (
  api: Pick<Api, "viewer" | "getIssue" | Write>,
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
  // A read already in flight when a write lands keys the old generation, so it cannot refill.
  let generation = 0;
  const invalidate = Effect.suspend(() => {
    generation += 1;
    return Cache.invalidateAll(issues);
  });
  const invalidating =
    <Args extends ReadonlyArray<unknown>, A>(
      write: (...args: Args) => Effect.Effect<A, IssueTrackerError>,
    ) =>
    (...args: Args) =>
      write(...args).pipe(Effect.ensuring(invalidate));

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
  return overrides;
});
