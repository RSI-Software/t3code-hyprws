// Fork-only (colleague-collab): who is typing in a shared thread's composer. In memory only; a
// typist the server stops hearing from drops after `TYPING_TTL`.
import type { CollaboratorTypingStateFork, CollaboratorTypistFork } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

// Clients heartbeat about every two seconds while the draft changes.
const TYPING_TTL = Duration.seconds(5);

interface Typing {
  readonly threadId: string;
  readonly typist: CollaboratorTypistFork;
}

const sameState = (a: CollaboratorTypingStateFork, b: CollaboratorTypingStateFork) =>
  a.shared === b.shared &&
  a.typists.length === b.typists.length &&
  a.typists.every((typist, index) => typist.subject === b.typists[index]?.subject);

export const makeCollaboratorTyping = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<ReadonlyArray<Typing>>([]);
  const expiries = yield* FiberMap.make<string>();
  const key = (threadId: string, subject: string) => JSON.stringify([threadId, subject]);
  const isEntry = (threadId: string, subject: string) => (entry: Typing) =>
    entry.threadId === threadId && entry.typist.subject === subject;
  const forget = (threadId: string, subject: string) =>
    SubscriptionRef.update(ref, (all) =>
      all.some(isEntry(threadId, subject))
        ? all.filter((entry) => !isEntry(threadId, subject)(entry))
        : all,
    );

  const start = Effect.fn("CollaboratorTypingFork.start")(function* (
    threadId: string,
    typist: CollaboratorTypistFork,
  ) {
    yield* SubscriptionRef.update(ref, (all) =>
      all.some(isEntry(threadId, typist.subject)) ? all : [...all, { threadId, typist }],
    );
    // Each heartbeat restarts the countdown.
    yield* FiberMap.run(
      expiries,
      key(threadId, typist.subject),
      Effect.sleep(TYPING_TTL).pipe(Effect.andThen(forget(threadId, typist.subject))),
      { startImmediately: true },
    );
  });

  const stop = Effect.fn("CollaboratorTypingFork.stop")(function* (
    threadId: string,
    subject: string,
  ) {
    yield* FiberMap.remove(expiries, key(threadId, subject));
    yield* forget(threadId, subject);
  });

  return {
    start,
    stop,
    /** Everyone but `viewer` typing in the thread while `shared`, re-emitted only on a change. */
    state: (threadId: string, viewer: string, shared: Stream.Stream<boolean>) =>
      Stream.zipLatestWith(
        shared,
        SubscriptionRef.changes(ref),
        (shared, all): CollaboratorTypingStateFork => ({
          shared,
          typists: shared
            ? all.flatMap((entry) =>
                entry.threadId === threadId && entry.typist.subject !== viewer
                  ? [entry.typist]
                  : [],
              )
            : [],
        }),
      ).pipe(Stream.changesWith(sameState)),
  };
});
