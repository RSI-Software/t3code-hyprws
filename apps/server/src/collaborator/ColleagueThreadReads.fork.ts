// Fork-only (colleague-collab): what a saved colleague's agent reads here, called by their server
// with the colleague's own grant. Every thread passes `CollaboratorSharesFork.canRead`, the one read
// check, so the agent reads exactly what the colleague's app shows. Nothing here writes.
import {
  type ColleagueThreadFork,
  type ColleagueThreadInputFork,
  type ColleagueThreadResultFork,
  type ColleagueThreadsInputFork,
  type ColleagueThreadsResultFork,
  type MessageId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { listItemFromShellFork, timelineItemFork } from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as CollaboratorShares from "./CollaboratorShares.fork.ts";

const LIST_LIMIT = 50;
const READ_LIMIT = 30;
const MAX_CHARS_PER_ITEM = 4_000;
const CHECK_CONCURRENCY = 8;

/** Refused or missing look the same, so a colleague learns nothing of threads they cannot read. */
export class ColleagueThreadUnreadableErrorFork extends Schema.TaggedError<ColleagueThreadUnreadableErrorFork>()(
  "ColleagueThreadUnreadableErrorFork",
  { threadId: Schema.String },
) {
  override get message() {
    return "That thread is not in a team project here, and nobody shared it with you.";
  }
}

export class ColleagueThreadReadErrorFork extends Schema.TaggedError<ColleagueThreadReadErrorFork>()(
  "ColleagueThreadReadErrorFork",
  {
    stage: Schema.Literals(["list", "search", "snapshot", "shell", "timeline", "messages"]),
    projectId: Schema.optional(Schema.String),
    threadId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not read threads here: the ${this.stage} read failed.`;
  }
}

export class ColleagueThreadReadsFork extends Context.Service<
  ColleagueThreadReadsFork,
  {
    /** The threads `subject` may read, newest first, or the ones a keyword search finds there. */
    readonly list: (
      subject: string,
      input: ColleagueThreadsInputFork,
    ) => Effect.Effect<ColleagueThreadsResultFork, ColleagueThreadReadErrorFork>;
    /** One thread `subject` may read: its newest messages, or the page before `beforePosition`. */
    readonly read: (
      subject: string,
      input: ColleagueThreadInputFork,
    ) => Effect.Effect<
      ColleagueThreadResultFork,
      ColleagueThreadUnreadableErrorFork | ColleagueThreadReadErrorFork
    >;
  }
>()("t3/collaborator/ColleagueThreadReads.fork/ColleagueThreadReadsFork") {}

const make = Effect.gen(function* () {
  const shares = yield* CollaboratorShares.CollaboratorSharesFork;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const search = yield* ThreadSearch.ThreadSearch;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  // Links name this environment, which the colleague's app has attached.
  const toItem = Effect.gen(function* () {
    const { environmentId } = yield* environment.getDescriptor;
    const scope: McpInvocationScope = {
      environmentId,
      capabilities: new Set(),
      issuedAt: 0,
      requestNamespace: "colleague",
      thread: undefined,
      client: undefined,
    };
    const nowMs = yield* Clock.currentTimeMillis;
    return (shell: OrchestrationV2ThreadShell): ColleagueThreadFork =>
      listItemFromShellFork(scope, shell, nowMs);
  });

  const list: ColleagueThreadReadsFork["Service"]["list"] = Effect.fn(
    "ColleagueThreadReadsFork.list",
  )(function* (subject, input) {
    const entries = yield* threads
      .listProjectThreads({ includeSubagents: false })
      .pipe(Effect.mapError((cause) => new ColleagueThreadReadErrorFork({ stage: "list", cause })));
    const readable = yield* Effect.filter(entries, (entry) => shares.canRead(subject, entry.id), {
      concurrency: CHECK_CONCURRENCY,
    });
    const matches = new Map<ThreadId, ColleagueThreadFork["match"]>();
    if (input.query === undefined) {
      for (const { id } of readable.slice(0, LIST_LIMIT)) matches.set(id, undefined);
    } else {
      const ids = new Set(readable.map(({ id }) => id));
      // Per project, so threads it may not read never crowd out the ones it may.
      for (const projectId of new Set(readable.map((entry) => entry.projectId))) {
        const found = yield* search
          .searchThreads({ query: input.query, projectId, limit: LIST_LIMIT })
          .pipe(
            Effect.mapError(
              (cause) => new ColleagueThreadReadErrorFork({ stage: "search", projectId, cause }),
            ),
          );
        for (const hit of found.matches) {
          if (!ids.has(hit.threadId) || matches.has(hit.threadId)) continue;
          matches.set(hit.threadId, {
            source: hit.source,
            ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
          });
        }
      }
    }
    const picked = [...matches.keys()].slice(0, LIST_LIMIT);
    const snapshot =
      picked.length === 0
        ? { threads: [] }
        : yield* threads
            .getShellSnapshot({ location: "active", threadIds: picked })
            .pipe(
              Effect.mapError(
                (cause) => new ColleagueThreadReadErrorFork({ stage: "snapshot", cause }),
              ),
            );
    const shells = new Map(snapshot.threads.map((shell) => [shell.id, shell]));
    const item = yield* toItem;
    return {
      threads: picked.flatMap((id) => {
        const shell = shells.get(id);
        if (shell === undefined) return [];
        const match = matches.get(id);
        return [{ ...item(shell), ...(match === undefined ? {} : { match }) }];
      }),
    };
  });

  const read: ColleagueThreadReadsFork["Service"]["read"] = Effect.fn(
    "ColleagueThreadReadsFork.read",
  )(function* (subject, input) {
    const { threadId } = input;
    if (!(yield* shares.canRead(subject, threadId))) {
      return yield* new ColleagueThreadUnreadableErrorFork({ threadId });
    }
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError(
          (cause) => new ColleagueThreadReadErrorFork({ stage: "shell", threadId, cause }),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* new ColleagueThreadUnreadableErrorFork({ threadId });
    }
    const timeline = yield* threads
      .getTimelinePage(threadId, {
        beforePosition: input.beforePosition ?? Number.POSITIVE_INFINITY,
        limit: READ_LIMIT,
        view: "messages",
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      })
      .pipe(
        Effect.mapError(
          (cause) => new ColleagueThreadReadErrorFork({ stage: "timeline", threadId, cause }),
        ),
      );
    const messageIds = new Map<ThreadId, Array<MessageId>>();
    for (const { item: turnItem, sourceThreadId } of timeline.items) {
      if (turnItem.type !== "user_message" && turnItem.type !== "assistant_message") continue;
      messageIds.set(sourceThreadId, [
        ...(messageIds.get(sourceThreadId) ?? []),
        turnItem.messageId,
      ]);
    }
    const messagesByThreadId = new Map(
      yield* Effect.forEach([...messageIds], ([sourceThreadId, ids]) =>
        threads.getThreadRecords(sourceThreadId, ["messages"], { messageIds: ids }).pipe(
          Effect.map((records) => [sourceThreadId, records.messages] as const),
          Effect.mapError(
            (cause) =>
              new ColleagueThreadReadErrorFork({
                stage: "messages",
                threadId: sourceThreadId,
                cause,
              }),
          ),
        ),
      ),
    );
    const items = timeline.items.map((row) =>
      timelineItemFork({
        row,
        maxChars: MAX_CHARS_PER_ITEM,
        messagesByThreadId,
        ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
      }),
    );
    const item = yield* toItem;
    return {
      thread: item(shell),
      items,
      earlierPosition: timeline.hasEarlier ? (items[0]?.position ?? null) : null,
    };
  });

  return ColleagueThreadReadsFork.of({ list, read });
});

export const layer = Layer.effect(ColleagueThreadReadsFork, make);
