// Fork-only (colleague-collab): who is typing in a shared thread's composer. In memory only; a
// typist the server stops hearing from drops after `TYPING_TTL`.
import type { CollaboratorTypistFork } from "@t3tools/contracts";
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

const sameSubjects = (
  a: ReadonlyArray<CollaboratorTypistFork>,
  b: ReadonlyArray<CollaboratorTypistFork>,
) => a.length === b.length && a.every((typist, index) => typist.subject === b[index]?.subject);

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

  return {
    start,
    stop: (threadId: string, subject: string) =>
      FiberMap.remove(expiries, key(threadId, subject)).pipe(
        Effect.andThen(forget(threadId, subject)),
      ),
    /** Everyone typing in the thread but `viewer`, re-emitted only when that set changes. */
    typists: (threadId: string, viewer: string, visible: () => boolean) =>
      SubscriptionRef.changes(ref).pipe(
        Stream.map((all) =>
          visible()
            ? all.flatMap((entry) =>
                entry.threadId === threadId && entry.typist.subject !== viewer
                  ? [entry.typist]
                  : [],
              )
            : [],
        ),
        Stream.changesWith(sameSubjects),
      ),
  };
});
