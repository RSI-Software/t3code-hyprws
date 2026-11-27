import {
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ThreadDetailSnapshot,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { makeThreadProjectionFixture } from "../../test-fixtures";
import {
  copySharedThreadFork,
  sharedThreadsInSyncFork,
  sharedThreadsToCopyFork,
} from "./colleagueCopy.logic.fork";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("alex"),
  label: "Alex",
  httpBaseUrl: "https://alex.example.test",
  wsBaseUrl: "wss://alex.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const PROJECTION = makeThreadProjectionFixture();
const THREAD_ID = PROJECTION.thread.id;
const AT = DateTime.makeUnsafe("2026-11-27T00:00:00.000Z");

const messageRow = (text: string, ordinal: number) => ({
  position: ordinal,
  visibility: "local" as const,
  sourceThreadId: THREAD_ID,
  sourceItemId: TurnItemId.make(text),
  item: {
    id: TurnItemId.make(text),
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: AT,
    completedAt: AT,
    updatedAt: AT,
    type: "user_message" as const,
    createdBy: "user" as const,
    creationSource: "web" as const,
    messageId: MessageId.make(text),
    inputIntent: "turn_start" as const,
    text,
    attachments: [],
  },
});

const snapshot = (sequence: number, texts: ReadonlyArray<string>) =>
  ({
    snapshotSequence: sequence,
    projection: { ...PROJECTION, visibleTurnItems: texts.map(messageRow) },
  }) satisfies OrchestrationV2ThreadDetailSnapshot;

/** Copies once per host fetch, against an in-memory thread cache holding `held`. */
const copyAll = (
  held: OrchestrationV2ThreadDetailSnapshot,
  fetches: ReadonlyArray<OrchestrationV2ThreadDetailSnapshot>,
) =>
  Effect.gen(function* () {
    let copy = held;
    const answers = [...fetches];
    const cache = Persistence.EnvironmentCacheStore.of({
      loadShell: () => Effect.succeedNone,
      saveShell: () => Effect.void,
      loadThread: () => Effect.succeedSome(copy),
      saveThread: (_environmentId, saved) => Effect.sync(() => void (copy = saved)),
      removeThread: () => Effect.void,
      loadServerConfig: () => Effect.succeedNone,
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeedNone,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
    const loader = ThreadSnapshotLoader.of({
      load: () => {
        const next = answers.shift();
        return Effect.succeed(
          next === undefined
            ? { _tag: "unavailable" as const }
            : { _tag: "present" as const, snapshot: next },
        );
      },
    });
    for (const _ of fetches) {
      yield* copySharedThreadFork(
        TARGET.environmentId,
        PREPARED,
        THREAD_ID,
        Effect.succeed(true),
      ).pipe(
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ThreadSnapshotLoader, loader),
      );
    }
    return copy.projection.visibleTurnItems.map((row) => row.sourceItemId);
  });

describe("colleague copies", () => {
  it("copies each shared thread between runs, once per change, and knows which are in sync", () => {
    const row = {
      id: THREAD_ID,
      collaboratorFork: "send" as const,
      activeRunId: null,
      latestRunId: null,
      itemCount: 2,
      updatedAt: AT,
    };
    const running = { ...row, id: ThreadId.make("running"), activeRunId: RunId.make("run-1") };
    const unshared = { ...row, id: ThreadId.make("unshared"), collaboratorFork: "frozen" as const };
    const own = { ...row, id: ThreadId.make("own"), collaboratorFork: undefined };
    const first = sharedThreadsToCopyFork([row, running, unshared, own], new Map());
    expect(first.map(({ threadId }) => threadId)).toEqual([THREAD_ID]);

    const copied = new Map([[THREAD_ID, first[0]!.version]]);
    expect(sharedThreadsToCopyFork([row], copied)).toEqual([]);
    expect(sharedThreadsToCopyFork([{ ...row, itemCount: 3 }], copied)).toHaveLength(1);
    expect(sharedThreadsInSyncFork([row], copied)).toEqual([THREAD_ID]);
    expect(sharedThreadsInSyncFork([{ ...row, itemCount: 3 }], copied)).toEqual([]);
  });

  it.effect("a host's return catches the copy up without duplicating its turns", () =>
    Effect.gen(function* () {
      const caughtUp = yield* copyAll(snapshot(5, ["plan", "reply"]), [
        snapshot(9, ["plan", "reply", "follow-up"]),
      ]);
      expect(caughtUp).toEqual(["plan", "reply", "follow-up"]);
    }),
  );

  it.effect("an older fetch never replaces a newer copy", () =>
    Effect.gen(function* () {
      const kept = yield* copyAll(snapshot(9, ["plan", "reply", "follow-up"]), [
        snapshot(5, ["plan", "reply"]),
      ]);
      expect(kept).toEqual(["plan", "reply", "follow-up"]);
    }),
  );
});
