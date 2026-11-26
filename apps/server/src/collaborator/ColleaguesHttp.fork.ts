// Fork-only (colleague-collab): the routes a saved colleague's server calls with its grant here.
// The caller's subject is the colleague; nothing in the body names anyone.
import {
  COLLEAGUE_FORGET_ROUTE_FORK,
  COLLEAGUE_PAIR_CLIENT_ROUTE_FORK,
  type ColleagueErrorFork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
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

export const routeLayerFork = Layer.mergeAll(
  route(COLLEAGUE_PAIR_CLIENT_ROUTE_FORK, (colleagues, session) =>
    colleagues.issueClientPairing(session),
  ),
  route(COLLEAGUE_FORGET_ROUTE_FORK, (colleagues, session) => colleagues.forget(session.subject)),
);
