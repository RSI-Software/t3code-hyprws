import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** Activity is expensive: turns refresh status, but only edits refresh mounted activity. */
export const makePullRequestRefreshesFork = Effect.gen(function* () {
  const revisions = yield* SubscriptionRef.make({ all: 0, activity: 0 });
  const changes = (field: "all" | "activity") =>
    SubscriptionRef.changes(revisions).pipe(
      Stream.map((value) => value[field]),
      Stream.changes,
      Stream.filter((revision) => revision > 0),
    );
  return {
    all: changes("all"),
    activity: changes("activity"),
    publish: (revision: number, afterTurn = false) =>
      SubscriptionRef.update(revisions, (previous) => ({
        all: revision,
        activity: afterTurn ? previous.activity : revision,
      })),
  };
});
