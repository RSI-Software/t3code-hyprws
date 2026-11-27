import {
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import { readColleagueThreadFork } from "@t3tools/client-runtime/state/colleague-thread-read";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ThreadDetailSnapshot,
  ProjectId,
  type RepositoryIdentity,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import { makeThreadProjectionFixture } from "../../test-fixtures";
import { matchingProjectFork } from "./colleagueFork.logic.fork";

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

const row = (text: string, ordinal: number, type: "user_message" | "assistant_message") => ({
  position: ordinal,
  visibility: "local" as const,
  sourceThreadId: THREAD_ID,
  sourceItemId: TurnItemId.make(`item-${ordinal}`),
  item: {
    id: TurnItemId.make(`item-${ordinal}`),
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
    messageId: MessageId.make(`message-${ordinal}`),
    text,
    ...(type === "user_message"
      ? {
          type,
          createdBy: "user" as const,
          creationSource: "web" as const,
          inputIntent: "turn_start" as const,
          // An empty text stands for an image-only message.
          attachments:
            text === ""
              ? [
                  {
                    type: "image" as const,
                    id: "img",
                    name: "plan.png",
                    mimeType: "image/png",
                    sizeBytes: 1,
                  },
                ]
              : [],
        }
      : { type, streaming: false }),
  },
});

const snapshot = (texts: ReadonlyArray<string>, hasMoreHistory: boolean) =>
  ({
    snapshotSequence: 1,
    projection: {
      ...PROJECTION,
      visibleTurnItems: texts.map((text, index) =>
        row(text, index + 1, index % 2 === 0 ? "user_message" : "assistant_message"),
      ),
    },
    hasMoreHistory,
  }) satisfies OrchestrationV2ThreadDetailSnapshot;

/** Reads with the host answering `host` (absent: offline) over a device copy `copy`. */
const read = (input: {
  readonly host?: OrchestrationV2ThreadDetailSnapshot | null;
  readonly copy?: OrchestrationV2ThreadDetailSnapshot;
}) =>
  readColleagueThreadFork(
    TARGET.environmentId,
    input.host === undefined ? Option.none() : Option.some(PREPARED),
    THREAD_ID,
  ).pipe(
    Effect.provideService(
      Persistence.EnvironmentCacheStore,
      Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.fromNullishOr(input.copy)),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      }),
    ),
    Effect.provideService(
      ThreadSnapshotLoader,
      ThreadSnapshotLoader.of({
        load: () =>
          Effect.succeed(
            input.host == null
              ? { _tag: "unavailable" as const }
              : {
                  _tag: "present" as const,
                  snapshot: input.host,
                  history: { historyCursor: null, hasMoreHistory: false },
                },
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("no history page in these threads")),
    ),
  );

describe("forking a colleague's thread", () => {
  it.effect("reads the host while it answers, else this device's copy, else nothing", () =>
    Effect.gen(function* () {
      const copy = snapshot(["plan", "reply", ""], true);
      const live = yield* read({ host: snapshot(["plan", "reply", "follow-up"], false), copy });
      expect(live).toMatchObject({ source: "host", partial: false, omittedAttachments: 0 });
      expect(live.messages.map(({ role, text }) => `${role}:${text}`)).toEqual([
        "user:plan",
        "assistant:reply",
        "user:follow-up",
      ]);

      // An unreachable host falls back to the copy, which lacks its oldest messages. Its image
      // is not copied, so its message names it instead.
      for (const host of [undefined, null]) {
        const offline = yield* read({ ...(host === undefined ? {} : { host }), copy });
        expect(offline).toMatchObject({ source: "copy", partial: true, omittedAttachments: 1 });
        expect(offline.messages.map(({ text }) => text)).toEqual([
          "plan",
          "reply",
          "[Not copied: plan.png]",
        ]);
      }

      expect(yield* read({})).toEqual({
        messages: [],
        partial: false,
        source: "none",
        omittedAttachments: 0,
      });
    }),
  );

  it("preselects the one project here with the colleague's repository", () => {
    const identity = (canonicalKey: string): RepositoryIdentity => ({
      canonicalKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: canonicalKey },
    });
    const project = (id: string, key: string | null) => ({
      id: ProjectId.make(id),
      repositoryIdentity: key === null ? null : identity(key),
    });
    const source = { repositoryIdentity: identity("github.com/acme/launch") };
    expect(
      matchingProjectFork(source, [
        project("scratch", null),
        project("launch", "github.com/acme/launch"),
        project("other", "github.com/acme/other"),
      ]),
    ).toBe(ProjectId.make("launch"));
    expect(
      matchingProjectFork(source, [
        project("launch", "github.com/acme/launch"),
        project("launch-copy", "github.com/acme/launch"),
      ]),
    ).toBeNull();
    expect(
      matchingProjectFork(undefined, [project("launch", "github.com/acme/launch")]),
    ).toBeNull();
  });
});
