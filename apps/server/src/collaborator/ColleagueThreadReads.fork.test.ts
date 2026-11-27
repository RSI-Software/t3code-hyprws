import { assert } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureForkSchema } from "../persistence/ForkSchema.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ColleagueThreadReads from "./ColleagueThreadReads.fork.ts";
import {
  AGENT_REPLY,
  database,
  hostDispatches,
  other,
  projectOf,
  shared,
  sharedProject,
  withService,
} from "./CollaboratorShares.fork.testFixtures.ts";

// Search ignores the project, so only the read check keeps the private thread out.
const search = Layer.mock(ThreadSearch.ThreadSearch)({
  searchThreads: () =>
    Effect.succeed({
      matches: [shared, other].map((threadId) => ({
        threadId,
        projectId: projectOf[threadId]!,
        title: `Thread ${threadId}`,
        source: "assistant" as const,
        snippet: "login timeout",
      })),
    }),
});
const environment = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getDescriptor: Effect.succeed({ environmentId: EnvironmentId.make("env-host") } as never),
});

database((it) => {
  it.effect("a colleague's agent reads team threads only, and never writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureForkSchema();
      yield* sql`
        INSERT INTO fork_colleagues (subject, name, environment_id, url, secret_name, saved_at)
        VALUES ('colleague:alex', 'Alex', 'env-alex', 'http://alex', 'secret', '')
      `;
      yield* sql`INSERT INTO fork_team_projects (project_id, marked_at) VALUES (${sharedProject}, '')`;
      const dispatchesBefore = hostDispatches.length;
      yield* withService(
        Effect.gen(function* () {
          const reads = yield* ColleagueThreadReads.ColleagueThreadReadsFork;
          const ids = (result: {
            readonly threads: ReadonlyArray<{ readonly threadId: string }>;
          }) => result.threads.map(({ threadId }) => threadId);
          assert.deepStrictEqual(ids(yield* reads.list("colleague:alex", {})), [shared]);
          const found = yield* reads.list("colleague:alex", { query: "timeout" });
          assert.deepStrictEqual(ids(found), [shared]);
          assert.strictEqual(found.threads[0]?.match?.snippet, "login timeout");

          const read = yield* reads.read("colleague:alex", { threadId: shared });
          // The link opens in the colleague's app, which has this environment attached.
          assert.include(read.thread.link, "t3-thread://v2/env-host/shared");
          assert.deepStrictEqual(
            read.items.map(({ createdBy, text }) => [createdBy, text]),
            [["agent", AGENT_REPLY]],
          );

          // A thread outside the team projects, and a one-time guest, are refused plainly.
          const refused = yield* Effect.flip(reads.read("colleague:alex", { threadId: other }));
          assert.strictEqual(
            refused.message,
            "That thread is not in a team project here, and nobody shared it with you.",
          );
          assert.deepStrictEqual(ids(yield* reads.list("colleague:pat", {})), []);
          assert.strictEqual(
            (yield* Effect.flip(reads.read("colleague:pat", { threadId: shared })))._tag,
            "ColleagueThreadUnreadableErrorFork",
          );
        }).pipe(
          Effect.provide(
            ColleagueThreadReads.layer.pipe(Layer.provide(Layer.merge(search, environment))),
          ),
        ),
      );
      // Reads start no turn and send nothing on the host.
      assert.strictEqual(hostDispatches.length, dispatchesBefore);
    }),
  );
});
