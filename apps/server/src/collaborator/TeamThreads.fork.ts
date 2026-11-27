// Fork-only (colleague-collab): a saved colleague reads every thread of a team project, with no
// share rows. Access is derived from `fork_colleagues` and `fork_team_projects`; `CollaboratorSession`
// joins it with hand shares into one read check; a write goes through the host's approval.
import { type ApplicationStoredEvent, type ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";

export const makeTeamThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;

  const readTeam = sql<{ readonly projectId: string }>`
    SELECT project_id AS "projectId" FROM fork_team_projects
  `.pipe(Effect.map((rows): ReadonlySet<string> => new Set(rows.map((row) => row.projectId))));
  const NONE: ReadonlySet<string> = new Set();
  const team = yield* SubscriptionRef.make(yield* readTeam.pipe(Effect.orDie));
  // A mark, an unmark, or a thread moving project changes who reads what.
  const touchesTeam = (stored: ApplicationStoredEvent) =>
    "aggregateKind" in stored
      ? stored.aggregateKind === "project"
      : stored.event.type === "thread.metadata-updated";
  // The cursor before the read, so a mark landing between them is replayed, not missed.
  const watch = Effect.gen(function* () {
    const afterSequence = yield* events.latestApplicationSequence;
    yield* Stream.concat(
      Stream.succeed(undefined),
      events.streamApplicationEvents({ afterSequence }).pipe(Stream.filter(touchesTeam)),
    ).pipe(
      // Every touch publishes, so open thread views recheck their thread's project.
      Stream.mapEffect(() =>
        readTeam.pipe(Effect.flatMap((next) => SubscriptionRef.set(team, next))),
      ),
      Stream.runDrain,
    );
  });
  yield* watch.pipe(
    // Fail closed: a broken watcher grants no team access until it reads fresh marks.
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : SubscriptionRef.set(team, NONE).pipe(
            Effect.andThen(
              Effect.logWarning("team project marks stopped updating; retrying", {
                failure: Cause.hasFails(cause) ? "store" : "defect",
              }),
            ),
          ),
    ),
    Effect.retry(Schedule.spaced("5 seconds")),
    Effect.ignore,
    Effect.forkScoped,
  );

  /**
   * The team projects this subject reads now, from the committed rows; none for a guest.
   * Untraced: it gates every shell item and frame of a colleague.
   */
  const marksOf = Effect.fnUntraced(
    function* (subject: string) {
      const rows = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId" FROM fork_team_projects
        WHERE EXISTS (SELECT 1 FROM fork_colleagues WHERE subject = ${subject})
      `;
      const marks: ReadonlySet<string> = new Set(rows.map((row) => row.projectId));
      return marks;
    },
    Effect.orElseSucceed(() => NONE),
  );

  // Untraced: `readable` runs it per frame.
  const projectOf = Effect.fnUntraced(
    function* (threadId: string) {
      const thread = yield* threads.getThreadShell(ThreadId.make(threadId));
      return thread === null || thread.deletedAt !== null ? undefined : thread.projectId;
    },
    Effect.orElseSucceed((): ProjectId | undefined => undefined),
  );

  /** May this subject read the thread through a team project now; failing closed. */
  const readable = Effect.fnUntraced(function* (subject: string, threadId: string) {
    const projectId = yield* projectOf(threadId);
    return projectId !== undefined && (yield* marksOf(subject)).has(projectId);
  });

  /** The saved colleague's name while they read the thread through a team project. */
  const colleagueName = Effect.fn("TeamThreads.colleagueName")(
    function* (subject: string, threadId: string) {
      if (!(yield* readable(subject, threadId))) return undefined;
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM fork_colleagues WHERE subject = ${subject}
      `;
      return rows[0]?.name;
    },
    Effect.orElseSucceed((): string | undefined => undefined),
  );

  return {
    /** Team project ids, now and on every event that may change access; not deduplicated. */
    changes: SubscriptionRef.changes(team),
    /** Republishes the marks: saving or forgetting a colleague changes who reads them. */
    touch: readTeam.pipe(
      Effect.flatMap((next) => SubscriptionRef.set(team, next)),
      Effect.catchCause(() => SubscriptionRef.set(team, NONE)),
    ),
    marksOf,
    readable,
    colleagueName,
  };
});
