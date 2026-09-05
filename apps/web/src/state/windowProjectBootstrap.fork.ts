import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { environmentShell } from "./shell";

/** Project-scoped lists wait only for their environment; the hub keeps upstream readiness. */
export const environmentShellBootstrappedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      return true;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    // A retrying environment is only transiently disconnected; give it its
    // first retries before treating the missing snapshot as settled.
    return !(connection.phase === "backoff" && connection.desired && connection.attempt <= 2);
  }).pipe(Atom.withLabel(`web-environment-shell-bootstrapped:${environmentId}`)),
);
