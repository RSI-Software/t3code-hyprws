// Fork-only (colleague-collab): a saved colleague reads every thread of a team project, with no
// share rows. Access is derived from `fork_colleagues` and `fork_team_projects`; `CollaboratorSession`
// joins it with hand shares into one read check, and refuses every write.
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

  /** Only a saved colleague reads team threads; a one-time guest sees its hand shares alone. */
  const isColleague = Effect.fn("TeamThreadsFork.isColleague")(
    function* (subject: string) {
      const rows = yield* sql`SELECT 1 FROM fork_colleagues WHERE subject = ${subject}`;
      return rows.length > 0;
    },
    Effect.orElseSucceed(() => false),
  );

  // Untraced: `readable` runs it per detail frame.
  const projectOf = Effect.fnUntraced(
    function* (threadId: string) {
      const thread = yield* threads.getThreadShell(ThreadId.make(threadId));
      return thread === null || thread.deletedAt !== null ? undefined : thread.projectId;
    },
    Effect.orElseSucceed((): ProjectId | undefined => undefined),
  );

  /**
   * May this subject read the thread through a team project now: a saved colleague, a marked
   * project. Reads the committed rows, failing closed. Untraced: it gates every detail frame.
   */
  const readable = Effect.fnUntraced(
    function* (subject: string, threadId: string) {
      const projectId = yield* projectOf(threadId);
      if (projectId === undefined) return false;
      const rows = yield* sql`
        SELECT 1 FROM fork_team_projects
        JOIN fork_colleagues ON fork_colleagues.subject = ${subject}
        WHERE fork_team_projects.project_id = ${projectId}
      `;
      return rows.length > 0;
    },
    Effect.orElseSucceed(() => false),
  );

  return {
    /** Team project ids, now and on every event that may change access; not deduplicated. */
    changes: SubscriptionRef.changes(team),
    isColleague,
    readable,
  };
});
