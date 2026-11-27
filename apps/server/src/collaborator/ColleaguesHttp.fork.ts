// Fork-only (colleague-collab): the routes a saved colleague's server calls with its grant here.
// The caller's subject is the colleague; nothing in the body names anyone.
import {
  AuthOrchestrationReadScope,
  COLLEAGUE_FORGET_ROUTE_FORK,
  COLLEAGUE_PAIR_CLIENT_ROUTE_FORK,
  COLLEAGUE_THREAD_ROUTE_FORK,
  COLLEAGUE_THREADS_ROUTE_FORK,
  type ColleagueErrorFork,
  ColleagueThreadInputFork,
  ColleagueThreadsInputFork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  type ColleagueThreadReadErrorFork,
  type ColleagueThreadUnreadableErrorFork,
  listColleagueThreadsFork,
  readColleagueThreadFork,
} from "./ColleagueThreadReads.fork.ts";
import * as Colleagues from "./Colleagues.fork.ts";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

const route = <A>(
  path: `/${string}`,
  answer: (
    colleagues: Colleagues.ColleaguesFork["Service"],
    session: EnvironmentAuth.AuthenticatedSession,
  ) => Effect.Effect<A, ColleagueErrorFork>,
) =>
  HttpRouter.add(
    "POST",
    path,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const colleagues = yield* Colleagues.ColleaguesFork;
      const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
      if (session._tag === "None") return json({ error: "Authentication required." }, 401);
      const refused = (error: ColleagueErrorFork) =>
        Effect.succeed(json({ error: error.message }, 403));
      const failed = (error: ColleagueErrorFork) =>
        Effect.succeed(json({ error: error.message }, 500));
      return yield* answer(colleagues, session.value).pipe(
        Effect.map((body) => json(body ?? {})),
        Effect.catchTags({
          ColleagueMissingErrorFork: refused,
          ColleagueSelfErrorFork: refused,
          ColleagueOwnGrantErrorFork: refused,
          ColleagueNotCollaboratorErrorFork: refused,
          ColleagueNoLiveShareErrorFork: refused,
          ColleagueNoScopeErrorFork: refused,
          ColleagueSavedAsAnotherErrorFork: refused,
          ColleagueNotHttpErrorFork: refused,
          ColleaguePublicHttpErrorFork: refused,
          ColleagueStorageErrorFork: failed,
          ColleagueSilentErrorFork: failed,
          ColleagueRevokedErrorFork: failed,
          ColleagueRemoteErrorFork: failed,
          ColleagueUnknownShapeErrorFork: failed,
        }),
      );
    }),
  );

/** A read for the calling colleague's subject; `canRead` inside decides every thread. */
const readRoute = <I, A, R>(
  path: `/${string}`,
  input: Schema.Codec<I, unknown>,
  answer: (
    subject: string,
    input: I,
  ) => Effect.Effect<A, ColleagueThreadUnreadableErrorFork | ColleagueThreadReadErrorFork, R>,
) =>
  HttpRouter.add(
    "POST",
    path,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
      if (session._tag === "None") return json({ error: "Authentication required." }, 401);
      if (!session.value.scopes.includes(AuthOrchestrationReadScope)) {
        return json({ error: "This grant cannot read threads." }, 403);
      }
      const body = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(input)),
        Effect.option,
      );
      if (body._tag === "None") return json({ error: "Unknown request shape." }, 400);
      return yield* answer(session.value.subject, body.value).pipe(
        Effect.map((result) => json(result)),
        Effect.catchTags({
          ColleagueThreadUnreadableErrorFork: (error) =>
            Effect.succeed(json({ error: error.message }, 404)),
          ColleagueThreadReadErrorFork: (error) =>
            Effect.succeed(json({ error: error.message }, 500)),
        }),
      );
    }),
  );

export const routeLayerFork = Layer.mergeAll(
  route(COLLEAGUE_PAIR_CLIENT_ROUTE_FORK, (colleagues, session) =>
    colleagues.issueClientPairing(session),
  ),
  route(COLLEAGUE_FORGET_ROUTE_FORK, (colleagues, session) => colleagues.forget(session.subject)),
  readRoute(COLLEAGUE_THREADS_ROUTE_FORK, ColleagueThreadsInputFork, listColleagueThreadsFork),
  readRoute(COLLEAGUE_THREAD_ROUTE_FORK, ColleagueThreadInputFork, readColleagueThreadFork),
);
