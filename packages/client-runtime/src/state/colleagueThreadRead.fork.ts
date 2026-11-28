// Fork-only (colleague-collab): what "Fork to my machine" copies from a colleague's thread. It reads
// the host's thread over HTTP while the host is reachable, history page by history page, and else
// this device's copy of it, which the web app keeps current while the host is reachable. Images and
// files the fork cannot copy are named in their message and in the new thread's notice.
import type {
  ChatAttachment,
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
import { resolveUserMessagePresentation } from "../userMessage.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import * as ThreadSnapshotHttp from "./threadSnapshotHttp.ts";

/** The contract's cap; a longer thread keeps its latest messages. */
const MAX_MESSAGES = 10_000;
const MAX_HISTORY_PAGES = 200;

/** One message as read, with the host's own attachments, which only the host holds bytes for. */
export interface ColleagueReadMessageFork {
  readonly role: ColleagueThreadMessageFork["role"];
  readonly text: string;
  readonly createdAt: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** A user message's author, as the shared thread named them; absent for the host's own. */
  readonly author?: string;
  readonly replyTo?: ColleagueThreadMessageFork["replyTo"];
}

export interface ColleagueThreadReadFork {
  readonly messages: ReadonlyArray<ColleagueReadMessageFork>;
  /** The thread's oldest messages are missing. */
  readonly partial: boolean;
  /** `host`: read live. `copy`: this device's copy. `none`: neither, so the fork only links. */
  readonly source: "host" | "copy" | "none";
}

/** The conversation messages among `items`, oldest first, each item once. */
const colleagueThreadMessagesFork = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<ColleagueReadMessageFork> => {
  const seen = new Set<string>();
  return items.flatMap((item): ReadonlyArray<ColleagueReadMessageFork> => {
    if (seen.has(item.id)) return [];
    seen.add(item.id);
    const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
    if (item.type === "assistant_message") {
      return item.text.trim() === ""
        ? []
        : [{ role: "assistant", text: item.text, createdAt, attachments: [] }];
    }
    if (item.type !== "user_message") return [];
    // The words people saw, not the attributed form the agent read.
    const shown = resolveUserMessagePresentation({ ...item, id: item.messageId, role: "user" });
    const text = shown.text.trim() === "" ? "" : shown.text;
    if (text === "" && item.attachments.length === 0) return [];
    const replyTo = item.context?.collaboratorFork?.replyTo;
    return [
      {
        role: "user",
        text,
        createdAt,
        attachments: item.attachments,
        ...(shown.guestName === undefined || shown.guestName.trim() === ""
          ? {}
          : { author: shown.guestName }),
        ...(replyTo === undefined ? {} : { replyTo }),
      },
    ];
  });
};

/**
 * The messages a fork sends: each with the copies `copy` made of its attachments on this server.
 * An attachment `copy` fails on, or yields null for, is named in its message and in
 * `missingAttachments` instead. Each user message names its author, `people.host` for the host's
 * own, except the lines of `people.you`, the person forking.
 */
export const colleagueForkMessagesFork = Effect.fn("ColleagueFork.copyAttachments")(function* <
  E,
  R,
>(
  messages: ReadonlyArray<ColleagueReadMessageFork>,
  copy: (attachment: ChatAttachment) => Effect.Effect<ChatAttachment | null, E, R>,
  people: { readonly host: string; readonly you: string | null },
) {
  const copies = yield* Effect.forEach(
    messages,
    (message) =>
      Effect.forEach(message.attachments, (attachment) =>
        copy(attachment).pipe(Effect.orElseSucceed(() => null)),
      ),
    { concurrency: 3 },
  );
  const missingAttachments: Array<string> = [];
  const forked = messages.flatMap((message, index): ReadonlyArray<ColleagueThreadMessageFork> => {
    const copied = copies[index]!.filter((attachment) => attachment !== null);
    const missing = message.attachments
      .filter((_, at) => copies[index]![at] === null)
      .map(({ name }) => name);
    missingAttachments.push(...missing);
    const text = [message.text, missing.length === 0 ? "" : `[Not copied: ${missing.join(", ")}]`]
      .filter((part) => part !== "")
      .join("\n\n");
    if (text === "" && copied.length === 0) return [];
    const author = message.role === "user" ? (message.author ?? people.host) : undefined;
    return [
      {
        role: message.role,
        text,
        createdAt: message.createdAt,
        ...(copied.length === 0 ? {} : { attachments: copied }),
        ...(author === undefined || author === people.you ? {} : { author }),
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      },
    ];
  });
  return { messages: forked, missingAttachments };
});

/** What a fork copies from `items`: at most the latest `MAX_MESSAGES` messages. */
const readOfFork = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  partial: boolean,
  source: ColleagueThreadReadFork["source"],
): ColleagueThreadReadFork => {
  const messages = colleagueThreadMessagesFork(items);
  return messages.length <= MAX_MESSAGES
    ? { messages, partial, source }
    : { messages: messages.slice(-MAX_MESSAGES), partial: true, source };
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
