// SPIKE RSI-713 (colleague-collab): a people-only side chat beside a shared thread. The agent
// never reads it; a line reaches the agent only when someone sends it across. In memory only.
import type { CollaboratorSideLineFork } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

interface StoredLine extends CollaboratorSideLineFork {
  readonly threadId: string;
}

export const makeCollaboratorSideChat = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const ref = yield* SubscriptionRef.make<ReadonlyArray<StoredLine>>([]);

  const say = Effect.fn("CollaboratorSideChatFork.say")(function* (
    threadId: string,
    name: string | undefined,
    text: string,
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    const line: StoredLine = {
      id: yield* random.uuidV4().pipe(Effect.orDie),
      threadId,
      text,
      at,
      ...(name === undefined ? {} : { name }),
    };
    yield* SubscriptionRef.update(ref, (all) => [...all, line]);
  });

  const find = (threadId: string, id: string) =>
    SubscriptionRef.get(ref).pipe(
      Effect.map((all) => all.find((line) => line.threadId === threadId && line.id === id)),
    );

  const markSent = (id: string, by: string) =>
    SubscriptionRef.update(ref, (all) =>
      all.map((line) => (line.id === id ? { ...line, sentBy: by } : line)),
    );

  return {
    say,
    find,
    markSent,
    lines: (threadId: string) =>
      SubscriptionRef.changes(ref).pipe(
        Stream.map((all) =>
          all.flatMap(({ threadId: lineThread, ...line }) =>
            lineThread === threadId ? [line] : [],
          ),
        ),
      ),
  };
});
