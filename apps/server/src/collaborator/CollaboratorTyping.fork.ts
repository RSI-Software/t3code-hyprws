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
  JSON.stringify(a) === JSON.stringify(b);

interface TypingContext {
  readonly shared: boolean;
  /** Everyone the thread is shared with, in the order they joined. */
  readonly people: ReadonlyArray<string>;
  readonly you: string | undefined;
}

export const makeCollaboratorTyping = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<ReadonlyArray<Typing>>([]);
  const expiries = yield* FiberMap.make<string>();
  const key = (threadId: string, { subject, device }: CollaboratorTypistFork) =>
    JSON.stringify([threadId, subject, device ?? null]);
  const same = (entry: Typing, threadId: string, typist: CollaboratorTypistFork) =>
    key(entry.threadId, entry.typist) === key(threadId, typist);
  const forget = (threadId: string, typist: CollaboratorTypistFork) =>
    SubscriptionRef.update(ref, (all) =>
      all.some((entry) => same(entry, threadId, typist))
        ? all.filter((entry) => !same(entry, threadId, typist))
        : all,
    );

  const start = Effect.fn("CollaboratorTypingFork.start")(function* (
    threadId: string,
    typist: CollaboratorTypistFork,
  ) {
    const entry = { threadId, typist };
    yield* SubscriptionRef.update(ref, (all) =>
      all.some((other) => same(other, threadId, typist))
        ? all.map((other) => (same(other, threadId, typist) ? entry : other))
        : [...all, entry],
    );
    // Each heartbeat restarts the countdown.
    yield* FiberMap.run(
      expiries,
      key(threadId, typist),
      Effect.sleep(TYPING_TTL).pipe(Effect.andThen(forget(threadId, typist))),
      { startImmediately: true },
    );
  });

  const remove = (threadId: string, match: (typist: CollaboratorTypistFork) => boolean) =>
    SubscriptionRef.get(ref).pipe(
      Effect.flatMap((all) =>
        Effect.forEach(
          all.filter((entry) => entry.threadId === threadId && match(entry.typist)),
          (entry) =>
            FiberMap.remove(expiries, key(threadId, entry.typist)).pipe(
              Effect.andThen(forget(threadId, entry.typist)),
            ),
          { discard: true },
        ),
      ),
    );

  /** Drops one device's draft; a person's other devices keep theirs. */
  const stop = Effect.fn("CollaboratorTypingFork.stop")(function* (
    threadId: string,
    { subject, device }: Pick<CollaboratorTypistFork, "subject" | "device">,
  ) {
    yield* remove(threadId, (typist) => typist.subject === subject && typist.device === device);
  });

  /** Drops every draft of the subject's, as unsharing does. */
  const drop = Effect.fn("CollaboratorTypingFork.drop")(function* (
    threadId: string,
    subject: string,
  ) {
    yield* remove(threadId, (typist) => typist.subject === subject);
  });

  return {
    start,
    stop,
    drop,
    /** Everyone but `viewer` typing in the thread while `shared`, re-emitted only on a change. */
    state: (threadId: string, viewer: string, context: Stream.Stream<TypingContext>) =>
      Stream.zipLatestWith(
        context,
        SubscriptionRef.changes(ref),
        ({ shared, people, you }, all): CollaboratorTypingStateFork => ({
          shared,
          typists: shared
            ? all.flatMap((entry) =>
                entry.threadId === threadId && entry.typist.subject !== viewer
                  ? [entry.typist]
                  : [],
              )
            : [],
          ...(shared ? { people } : {}),
          ...(you === undefined ? {} : { you, yourSubject: viewer }),
        }),
      ).pipe(Stream.changesWith(sameState)),
  };
});
