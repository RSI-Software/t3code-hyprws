// Fork-only (colleague-collab): the routes a saved colleague's server calls with its grant here.
// The caller's subject is the colleague; nothing in the body names anyone.
import { COLLEAGUE_FORGET_ROUTE_FORK, COLLEAGUE_PAIR_CLIENT_ROUTE_FORK } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ColleaguesFork } from "./Colleagues.fork.ts";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

const route = <A>(
  path: `/${string}`,
  answer: (
    colleagues: ColleaguesFork["Service"],
    subject: string,
  ) => Effect.Effect<A, { readonly reason: string; readonly message: string }>,
) =>
  HttpRouter.add(
    "POST",
    path,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const colleagues = yield* ColleaguesFork;
      const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
      if (session._tag === "None") return json({ error: "Authentication required." }, 401);
      return yield* answer(colleagues, session.value.subject).pipe(
        Effect.map((body) => json(body ?? {})),
        Effect.catch((error) =>
          Effect.succeed(json({ error: error.message }, error.reason === "missing" ? 403 : 500)),
        ),
      );
    }),
  );

export const routeLayerFork = Layer.mergeAll(
  route(COLLEAGUE_PAIR_CLIENT_ROUTE_FORK, (colleagues, subject) =>
    colleagues.issueClientPairing(subject),
  ),
  route(COLLEAGUE_FORGET_ROUTE_FORK, (colleagues, subject) => colleagues.forget(subject)),
);
