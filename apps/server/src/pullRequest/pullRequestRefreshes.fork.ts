import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** Activity is expensive: turns refresh status, but only edits refresh mounted activity. */
export const makePullRequestRefreshesFork = Effect.gen(function* () {
  const revisions = yield* SubscriptionRef.make(0);
  return {
    activity: SubscriptionRef.changes(revisions).pipe(Stream.filter((revision) => revision > 0)),
    publish: (revision: number) => SubscriptionRef.set(revisions, revision),
  };
});
