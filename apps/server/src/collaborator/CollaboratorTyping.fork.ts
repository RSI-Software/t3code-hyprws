// Fork-only (colleague-collab): who is writing in a shared thread's composer, with a read-only
// copy of their draft. In memory only; a typist the server stops hearing from drops after `TYPING_TTL`.
import type { CollaboratorTypingStateFork, CollaboratorTypistFork } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

// Clients heartbeat at least every two seconds while their draft is open.
const TYPING_TTL = Duration.seconds(5);

interface Typing {
  readonly threadId: string;
  readonly typist: CollaboratorTypistFork;
}

// A keepalive repeats the same draft, so only a change in who writes or what reaches viewers.
const sameState = (a: CollaboratorTypingStateFork, b: CollaboratorTypingStateFork) =>
  a.shared === b.shared && JSON.stringify(a.typists) === JSON.stringify(b.typists);

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
    const entry = { threadId, typist };
    yield* SubscriptionRef.update(ref, (all) =>
      all.some(isEntry(threadId, typist.subject))
        ? all.map((other) => (isEntry(threadId, typist.subject)(other) ? entry : other))
        : [...all, entry],
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
