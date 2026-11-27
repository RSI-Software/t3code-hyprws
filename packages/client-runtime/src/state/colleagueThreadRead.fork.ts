// Fork-only (colleague-collab): what "Fork to my machine" copies from a colleague's thread. It reads
// the host's thread over HTTP while the host is reachable, history page by history page, and else
// this device's copy of it, which the web app keeps current while the host is reachable.
import type {
  ColleagueThreadMessageFork,
  EnvironmentId,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import * as ThreadSnapshotHttp from "./threadSnapshotHttp.ts";

/** The contract's cap; a longer thread keeps its latest messages. */
const MAX_MESSAGES = 10_000;
const MAX_HISTORY_PAGES = 200;

export interface ColleagueThreadReadFork {
  readonly messages: ReadonlyArray<ColleagueThreadMessageFork>;
  /** The thread's oldest messages are missing. */
  readonly partial: boolean;
  /** Images and files the messages carried, which a fork does not copy. */
  readonly omittedAttachments: number;
  /** `host`: read live. `copy`: this device's copy. `none`: neither, so the fork only links. */
  readonly source: "host" | "copy" | "none";
}

/** The conversation messages among `items`, oldest first, each item once. */
const colleagueThreadMessagesFork = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<ColleagueThreadMessageFork> => {
  const seen = new Set<string>();
  return items.flatMap((item): ReadonlyArray<ColleagueThreadMessageFork> => {
    if (seen.has(item.id)) return [];
    seen.add(item.id);
    if (item.type !== "user_message" && item.type !== "assistant_message") return [];
    // A fork copies no images or files, so each message names the ones it carried.
    const names = item.type === "user_message" ? item.attachments.map(({ name }) => name) : [];
    const text = [
      item.text.trim() === "" ? "" : item.text,
      names.length === 0 ? "" : `[Not copied: ${names.join(", ")}]`,
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    if (text === "") return [];
    return [
      {
        role: item.type === "user_message" ? "user" : "assistant",
        text,
        createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
      },
    ];
  });
};

/** What a fork copies from `items`: at most the latest `MAX_MESSAGES` messages. */
const readOfFork = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  partial: boolean,
  source: ColleagueThreadReadFork["source"],
): ColleagueThreadReadFork => {
  const messages = colleagueThreadMessagesFork(items);
  const omittedAttachments = items.reduce(
    (count, item) => count + (item.type === "user_message" ? item.attachments.length : 0),
    0,
  );
  return messages.length <= MAX_MESSAGES
    ? { messages, partial, source, omittedAttachments }
    : { messages: messages.slice(-MAX_MESSAGES), partial: true, source, omittedAttachments };
};

/** The host's whole thread over HTTP: its bounded snapshot, then each older history page. */
const readFromHost = Effect.fn("ColleagueFork.readFromHost")(function* (
  prepared: PreparedConnection,
  threadId: ThreadId,
) {
  const loaded = yield* (yield* ThreadSnapshotHttp.ThreadSnapshotLoader).load(prepared, threadId);
  if (loaded._tag !== "present") return null;
  const httpClient = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const older: Array<ReadonlyArray<OrchestrationV2TurnItem>> = [];
  let cursor = loaded.history?.hasMoreHistory === true ? loaded.history.historyCursor : null;
  while (cursor !== null && older.length < MAX_HISTORY_PAGES) {
    const page = yield* fetchEnvironmentThreadHistoryPage({
      prepared,
      threadId,
      cursor,
      view: "conversation",
      signer,
      remoteAuthorization,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    older.unshift(page.items.map(({ item }) => item));
    cursor = page.hasMoreHistory && page.nextCursor !== cursor ? page.nextCursor : null;
  }
  return readOfFork(
    [...older.flat(), ...loaded.snapshot.projection.visibleTurnItems.map(({ item }) => item)],
    cursor !== null,
    "host",
  );
});

/**
 * The colleague's thread to fork: read live while `prepared` reaches the host, else this device's
 * copy, else nothing.
 */
export const readColleagueThreadFork = Effect.fn("ColleagueFork.readThread")(function* (
  environmentId: EnvironmentId,
  prepared: Option.Option<PreparedConnection>,
  threadId: ThreadId,
) {
  if (Option.isSome(prepared)) {
    const live = yield* readFromHost(prepared.value, threadId).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (live !== null) return live;
  }
  const copy = yield* (yield* Persistence.EnvironmentCacheStore)
    .loadThread(environmentId, threadId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(copy)) {
    return readOfFork([], false, "none");
  }
  const { projection, hasMoreHistory } = copy.value;
  return readOfFork(
    projection.visibleTurnItems.map(({ item }) => item),
    hasMoreHistory === true,
    "copy",
  );
});
