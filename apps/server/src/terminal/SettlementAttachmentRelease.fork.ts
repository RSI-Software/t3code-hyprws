import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";

interface Attachment {
  readonly status: string;
  readonly managedSessionIdentity: unknown | null;
  readonly process: PtyAdapter.PtyProcess | null;
}

/** Release only this consumer's managed clients and confirm their exact PTY exits. */
export const makeSettlementAttachmentReleaseFork =
  <Session extends Attachment, E extends Error>(input: {
    readonly sessionsForThread: (threadId: string) => Effect.Effect<ReadonlyArray<Session>>;
    readonly suspend: (session: Session) => Effect.Effect<void, E>;
    readonly withThreadLock: <A, Error, R>(
      threadId: string,
      effect: Effect.Effect<A, Error, R>,
    ) => Effect.Effect<A, Error, R>;
    readonly processKillGraceMs: number;
  }) =>
  ({ threadId }: { readonly threadId: string }) =>
    input
      .withThreadLock(
        threadId,
        Effect.gen(function* () {
          const managed = (yield* input.sessionsForThread(threadId)).filter(
            (session) => session.status === "running" && session.managedSessionIdentity !== null,
          );
          const released = yield* Effect.forEach(
            managed,
            (session) =>
              Effect.gen(function* () {
                const process = session.process;
                if (!process) return true;
                const exited = yield* Deferred.make<void>();
                const unsubscribe = process.onExit(() => {
                  Deferred.doneUnsafe(exited, Effect.void);
                });
                const result = yield* input
                  .suspend(session)
                  .pipe(
                    Effect.andThen(Deferred.await(exited)),
                    Effect.timeoutOption(input.processKillGraceMs + 1_000),
                    Effect.ensuring(Effect.sync(unsubscribe)),
                  );
                if (Option.isNone(result)) {
                  yield* Effect.logWarning("settled managed viewer did not confirm exit", {
                    threadId,
                    pid: process.pid,
                  });
                }
                return Option.isSome(result);
              }),
            { concurrency: 1 },
          );
          return released.every(Boolean);
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to release settled managed attachments", {
            threadId,
            detail: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
