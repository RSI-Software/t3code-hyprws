// Fork-owned handlers for the colleague MCP tools (colleague-collab). Each read goes to the
// colleague's server as the grant it gave this one, which answers only what that grant may read.
import { type ColleagueFork, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Colleagues from "../../../collaborator/Colleagues.fork.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ColleagueToolkitFork } from "./tools.fork.ts";

const unavailable = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

const fold = (name: string) => name.normalize("NFKC").toLocaleLowerCase();

const saved = Effect.gen(function* () {
  const colleagues = yield* (yield* Colleagues.ColleaguesFork).list;
  if (colleagues.length > 0) return colleagues;
  return yield* new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "The user has no saved colleagues. They save one by accepting a share invite.",
  });
});

const byName = (colleagues: ReadonlyArray<ColleagueFork>, name: string) => {
  const found = colleagues.find((colleague) => fold(colleague.name) === fold(name));
  return found !== undefined
    ? Effect.succeed(found)
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `No saved colleague is named "${name}". Saved: ${colleagues.map((colleague) => colleague.name).join(", ")}.`,
        }),
      );
};

export const ColleagueToolkitHandlersLiveFork = McpToolAccess.toLayer(ColleagueToolkitFork, {
  t3_colleague_threads: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const colleagues = yield* Colleagues.ColleaguesFork;
      const each = (colleague: ColleagueFork) =>
        colleagues
          .threadsOf(colleague.subject, input.query === undefined ? {} : { query: input.query })
          .pipe(
            Effect.map(({ threads }) => ({ name: colleague.name, threads })),
            // One machine offline leaves the others readable.
            Effect.catch((error) => Effect.succeed({ name: colleague.name, error: error.message })),
          );
      const all = yield* saved;
      const picked = input.colleague === undefined ? all : [yield* byName(all, input.colleague)];
      return { colleagues: yield* Effect.forEach(picked, each, { concurrency: "unbounded" }) };
    }),
  ),
  t3_colleague_thread_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const colleagues = yield* Colleagues.ColleaguesFork;
      const colleague = yield* byName(yield* saved, input.colleague);
      return yield* colleagues
        .threadOf(colleague.subject, {
          threadId: input.threadId,
          ...(input.beforePosition === undefined ? {} : { beforePosition: input.beforePosition }),
        })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
});
