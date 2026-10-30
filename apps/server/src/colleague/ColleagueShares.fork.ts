// Fork-only (colleague-collab): share one thread with a colleague through a pairing link.
// The colleague's session pairs the whole environment. Its shell, thread subscriptions, and
// commands are narrowed to the threads shared with its subject; other reads stay open.
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  COLLEAGUE_THREAD_LINK_PARAM,
  ColleagueShareErrorFork,
  type ColleagueShareThreadInputFork,
  type ColleagueShareThreadResultFork,
  ColleagueThreadMissingErrorFork,
  type ColleagueThreadSharesResultFork,
  ColleagueUnshareErrorFork,
  type ColleagueUnshareThreadInputFork,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2SubscribeShellInput,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { failEnvironmentScopeRequired } from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { buildPairingUrl, resolveHeadlessConnectionString } from "../startupAccess.ts";

const COLLEAGUE_SUBJECT_PREFIX = "colleague:";
const SHARE_LINK_TTL = Duration.hours(24);

const isColleagueSubject = (subject: string) => subject.startsWith(COLLEAGUE_SUBJECT_PREFIX);

// Case and punctuation fold on purpose, so "Sam" and "sam " reach the same paired colleague.
const colleagueSubject = (name: string) =>
  `${COLLEAGUE_SUBJECT_PREFIX}${name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")}`;

interface ColleagueShare {
  readonly name: string;
  readonly threadIds: ReadonlySet<string>;
}

interface ShareRow {
  readonly subject: string;
  readonly thread_id: string;
  readonly colleague_name: string;
}

const sharesFromRows = (rows: ReadonlyArray<ShareRow>) => {
  const shares = new Map<string, ColleagueShare>();
  for (const row of rows) {
    const prior = shares.get(row.subject);
    shares.set(row.subject, {
      name: row.colleague_name,
      threadIds: new Set([...(prior?.threadIds ?? []), row.thread_id]),
    });
  }
  return shares;
};

const sameIds = (a: ReadonlySet<string> = new Set(), b: ReadonlySet<string> = new Set()) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/** Narrows one shell item; an authoritative snapshot resets `projects` to the shared threads'. */
const filterShellItem = (
  share: ColleagueShare | undefined,
  projects: Set<string>,
  item: OrchestrationV2ShellStreamItem,
): OrchestrationV2ShellStreamItem | undefined => {
  const hasThread = (id: string) => share?.threadIds.has(id) === true;
  switch (item.kind) {
    case "synchronized":
      return item;
    case "snapshot": {
      const { olderSettled: _olderSettled, ...snapshot } = item.snapshot;
      // An enrichment snapshot only refreshes project metadata and carries no threads.
      if (item.resolvedRepositoryIdentityRoots !== undefined) {
        return {
          ...item,
          snapshot: {
            ...snapshot,
            projects: snapshot.projects.filter((project) => projects.has(project.id)),
          },
        };
      }
      const threads = snapshot.threads.filter((thread) => hasThread(thread.id));
      const archivedThreads = snapshot.archivedThreads.filter((thread) => hasThread(thread.id));
      projects.clear();
      for (const thread of [...threads, ...archivedThreads]) projects.add(thread.projectId);
      return {
        ...item,
        snapshot: {
          ...snapshot,
          threads,
          archivedThreads,
          projects: snapshot.projects.filter((project) => projects.has(project.id)),
        },
      };
    }
    case "project.updated":
      return projects.has(item.project.id) ? item : undefined;
    case "project.removed":
      return projects.has(item.projectId) ? item : undefined;
    case "thread.updated":
      return hasThread(item.thread.id) ? item : undefined;
    case "thread.removed":
      return hasThread(item.threadId) ? item : undefined;
  }
};

const {
  dispatchCommand: DISPATCH,
  subscribeShell: SHELL,
  subscribeThread: THREAD,
} = ORCHESTRATION_V2_WS_METHODS;

// `options: never` accepts each upstream handler whatever its RPC options type.
interface ColleagueHandlersFork<A, E, R, SE, SR, TE, TR> {
  readonly [DISPATCH]: (command: OrchestrationV2Command, options: never) => Effect.Effect<A, E, R>;
  readonly [SHELL]: (
    input: OrchestrationV2SubscribeShellInput,
    options: never,
  ) => Stream.Stream<OrchestrationV2ShellStreamItem, SE, SR>;
  readonly [THREAD]: (
    input: OrchestrationV2SubscribeThreadInput,
    options: never,
  ) => Stream.Stream<OrchestrationV2ThreadStreamItem, TE, TR>;
}

const itemSequence = (item: OrchestrationV2ThreadStreamItem) =>
  item.kind === "snapshot"
    ? item.snapshotSequence
    : item.kind === "synchronized"
      ? 0
      : item.sequence;

const commandThreadId = (command: OrchestrationV2Command) =>
  command.type === "thread.fork" || command.type === "thread.merge_back"
    ? command.targetThreadId
    : command.type === "delegated_task.request" ||
        command.type === "delegated_task.wake-policy" ||
        command.type === "delegated_task.completion-delivery.acknowledge" ||
        command.type === "delegated_task.completion-delivery.dispose" ||
        command.type === "thread.created.record"
      ? command.parentThreadId
      : command.threadId;

// A queued edit starts from the already attributed text, so the prefix is not repeated.
const attributed = (name: string, text: string) => {
  const prefix = `Message from colleague ${name}:\n\n`;
  return text.startsWith(prefix) ? text : `${prefix}${text}`;
};

const notShared = (
  requiredScope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  new EnvironmentAuthorizationError({
    message: "This thread is no longer shared with you.",
    requiredScope,
  });

export class ColleagueSharesFork extends Context.Service<
  ColleagueSharesFork,
  {
    readonly share: (
      input: ColleagueShareThreadInputFork,
    ) => Effect.Effect<
      ColleagueShareThreadResultFork,
      ColleagueShareErrorFork | ColleagueThreadMissingErrorFork
    >;
    readonly threadShares: (threadId: string) => Effect.Effect<ColleagueThreadSharesResultFork>;
    readonly unshare: (
      input: ColleagueUnshareThreadInputFork,
    ) => Effect.Effect<void, ColleagueUnshareErrorFork>;
    /** Narrows a colleague session's thread handlers; other sessions pass through unchanged. */
    readonly wrapHandlers: <A, E, R, SE, SR, TE, TR>(
      subject: string,
      handlers: ColleagueHandlersFork<A, E, R, SE, SR, TE, TR>,
    ) => ColleagueHandlersFork<
      A,
      E | EnvironmentAuthorizationError,
      R,
      SE,
      SR,
      TE | EnvironmentAuthorizationError,
      TR
    >;
  }
>()("t3/colleague/ColleagueShares.fork/ColleagueSharesFork") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const publicUrl = yield* Config.String("T3CODE_COLLEAGUE_PUBLIC_URL").pipe(Config.option);
  const pairingBaseUrl = Option.getOrElse(
    publicUrl,
    () =>
      config.devUrl?.origin ??
      resolveHeadlessConnectionString(config.host, config.port, {
        privateNetworkOnly: config.privateNetworkOnly,
      }),
  );

  const readShares = sql<ShareRow>`
    SELECT subject, thread_id, colleague_name FROM fork_colleague_shares
    ORDER BY created_at
  `.pipe(Effect.map(sharesFromRows));
  let current: ReadonlyMap<string, ColleagueShare> = yield* readShares.pipe(Effect.orDie);
  const ref = yield* SubscriptionRef.make(current);
  const reload = readShares.pipe(
    Effect.flatMap((next) => {
      current = next;
      return SubscriptionRef.set(ref, next);
    }),
  );

  const share = Effect.fn("ColleagueSharesFork.share")(function* (
    input: ColleagueShareThreadInputFork,
  ) {
    const { threadId } = input;
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError(
          (cause) => new ColleagueShareErrorFork({ operation: "read-thread", threadId, cause }),
        ),
      );
    if (thread === null || thread.deletedAt !== null) {
      return yield* new ColleagueThreadMissingErrorFork({ threadId });
    }
    const subject = colleagueSubject(input.colleagueName);
    const knownColleague = yield* auth.listSessions().pipe(
      Effect.map((sessions) => sessions.some((session) => session.subject === subject)),
      Effect.orElseSucceed(() => false),
    );
    // Minted first so a failure grants nothing; a paired colleague may still need it for a new device.
    const issued = yield* auth
      .createPairingLink({
        subject,
        label: `Colleague ${input.colleagueName}`,
        scopes: AuthStandardClientScopes,
        ttl: SHARE_LINK_TTL,
      })
      .pipe(
        Effect.mapError(
          (cause) => new ColleagueShareErrorFork({ operation: "pair", threadId, cause }),
        ),
      );
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO fork_colleague_shares (subject, thread_id, colleague_name, created_at)
      VALUES (${subject}, ${thread.id}, ${input.colleagueName}, ${createdAt})
      ON CONFLICT (subject, thread_id) DO NOTHING
    `.pipe(
      Effect.mapError(
        (cause) => new ColleagueShareErrorFork({ operation: "record-share", threadId, cause }),
      ),
    );
    yield* reload.pipe(
      Effect.mapError(
        (cause) => new ColleagueShareErrorFork({ operation: "read-shares", threadId, cause }),
      ),
    );
    // Pairing ignores the query, so the thread rides inside the pairing URL to the colleague's app.
    const pairing = new URL(buildPairingUrl(pairingBaseUrl, issued.credential));
    pairing.searchParams.set(COLLEAGUE_THREAD_LINK_PARAM, thread.id);
    const pairingUrl = pairing.toString();
    return { pairingUrl, appLink: buildPairingAppLink(pairingUrl), knownColleague };
  });

  const threadShares: ColleagueSharesFork["Service"]["threadShares"] = (threadId) =>
    Effect.sync(() => {
      const colleagues = [...current].map(([subject, { name }]) => ({ subject, name }));
      return {
        sharedWith: colleagues.filter(({ subject }) =>
          current.get(subject)?.threadIds.has(threadId),
        ),
        colleagues,
      };
    });

  const unshare = Effect.fn("ColleagueSharesFork.unshare")(function* (
    input: ColleagueUnshareThreadInputFork,
  ) {
    yield* sql`
      DELETE FROM fork_colleague_shares WHERE subject = ${input.subject} AND thread_id = ${input.threadId}
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ColleagueUnshareErrorFork({
            operation: "delete-share",
            threadId: input.threadId,
            cause,
          }),
      ),
    );
    yield* reload.pipe(
      Effect.mapError(
        (cause) =>
          new ColleagueUnshareErrorFork({
            operation: "read-shares",
            threadId: input.threadId,
            cause,
          }),
      ),
    );
  });

  const isShared = (subject: string, threadId: string) =>
    current.get(subject)?.threadIds.has(threadId) === true;

  const shell = <SE, SR>(
    subject: string,
    input: OrchestrationV2SubscribeShellInput,
    open: (
      input: OrchestrationV2SubscribeShellInput,
    ) => Stream.Stream<OrchestrationV2ShellStreamItem, SE, SR>,
  ) => {
    // Always a full, untrimmed snapshot: a resume could skip a thread shared since the last
    // connection, and the omissions could hide a shared thread.
    const {
      afterSequence: _resume,
      omitIdleSubagents: _idle,
      omitOlderSettled: _settled,
      ...fresh
    } = input;
    // A shared thread moving to a project the colleague cannot see re-snapshots to bring it in.
    const narrowed = (
      colleagueShare: ColleagueShare | undefined,
    ): Stream.Stream<OrchestrationV2ShellStreamItem, SE, SR> =>
      Stream.suspend(() => {
        const projects = new Set<string>();
        let moved = false;
        return open(fresh).pipe(
          Stream.map((item) => filterShellItem(colleagueShare, projects, item)),
          Stream.filter(Predicate.isNotUndefined),
          Stream.takeUntil(
            (item) =>
              (moved = item.kind === "thread.updated" && !projects.has(item.thread.projectId)),
            { excludeLast: true },
          ),
          Stream.concat(Stream.suspend(() => (moved ? narrowed(colleagueShare) : Stream.empty))),
        );
      });
    return SubscriptionRef.changes(ref).pipe(
      Stream.map((shares) => shares.get(subject)),
      Stream.changesWith((a, b) => sameIds(a?.threadIds, b?.threadIds)),
      Stream.switchMap(narrowed),
    );
  };

  const sharedChanges = (subject: string, threadId: string) =>
    SubscriptionRef.changes(ref).pipe(
      Stream.map((shares) => shares.get(subject)?.threadIds.has(threadId) === true),
      Stream.changes,
    );

  const wrapHandlers: ColleagueSharesFork["Service"]["wrapHandlers"] = (subject, handlers) => {
    if (!isColleagueSubject(subject)) return handlers;
    // The caller assigns the result back onto `handlers`, so capture the originals now.
    const { [DISPATCH]: dispatch, [SHELL]: subscribeShell, [THREAD]: subscribeThread } = handlers;
    return {
      [DISPATCH]: (command, options) => {
        if (!isShared(subject, commandThreadId(command))) {
          return Effect.fail(notShared(AuthOrchestrationOperateScope));
        }
        const name = current.get(subject)?.name;
        return dispatch(
          (command.type === "message.dispatch" || command.type === "queued-run.edit") &&
            name !== undefined
            ? { ...command, text: attributed(name, command.text) }
            : command,
          options,
        );
      },
      [SHELL]: (input, options) => shell(subject, input, (fresh) => subscribeShell(fresh, options)),
      // Unshared pauses silently, since the client retries a failed stream every 250ms.
      // A re-share resumes after the last sequence sent.
      [THREAD]: (input, options) => {
        let afterSequence = input.afterSequence;
        return sharedChanges(subject, input.threadId).pipe(
          Stream.switchMap((shared) =>
            shared
              ? subscribeThread(
                  afterSequence === undefined ? input : { ...input, afterSequence },
                  options,
                ).pipe(
                  Stream.tap((item) =>
                    Effect.sync(() => {
                      afterSequence = Math.max(afterSequence ?? 0, itemSequence(item));
                    }),
                  ),
                )
              : Stream.empty,
          ),
        );
      },
    };
  };

  return ColleagueSharesFork.of({ share, threadShares, unshare, wrapHandlers });
});

export const layer = Layer.effect(ColleagueSharesFork, make);

/** Colleague sessions read the shell over the socket, where it is filtered; refuse the HTTP copy. */
export const refuseColleagueHttpShellFork = Effect.gen(function* () {
  const principal = yield* EnvironmentAuthenticatedPrincipal;
  if (isColleagueSubject(principal.subject)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  }
});
