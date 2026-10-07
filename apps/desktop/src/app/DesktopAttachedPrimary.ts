import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  type AttachedPrimaryRejectReason,
  AuthStandardClientScopes,
  type RunningLocalServer,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import * as DesktopBackendMode from "./DesktopBackendMode.ts";
import * as DesktopRunningLocalServers from "./DesktopRunningLocalServers.ts";

export const ATTACHED_PRIMARY_SELECTION_NONE = "none" as const;
export const ATTACHED_PRIMARY_SELECTION_AUTO = "auto" as const;

export class DesktopAttachedPrimaryNotAttachedError extends Schema.TaggedError<DesktopAttachedPrimaryNotAttachedError>()(
  "DesktopAttachedPrimaryNotAttachedError",
  {},
) {
  override get message(): string {
    return "No local server is attached as the primary environment.";
  }
}

export class DesktopAttachedPrimaryUnavailableError extends Schema.TaggedError<DesktopAttachedPrimaryUnavailableError>()(
  "DesktopAttachedPrimaryUnavailableError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const DesktopAttachedPrimaryError = Schema.Union([
  DesktopAttachedPrimaryNotAttachedError,
  DesktopAttachedPrimaryUnavailableError,
]);
export type DesktopAttachedPrimaryError = typeof DesktopAttachedPrimaryError.Type;

export interface DesktopAttachedPrimarySnapshot {
  readonly server: RunningLocalServer;
}

interface AttachmentState {
  readonly selection: string;
  readonly server: RunningLocalServer;
  readonly bearerToken: string;
}

/** Last verified live server, served synchronously to the bootstrap IPC. */
interface CachedAttachedBootstrap {
  readonly server: RunningLocalServer;
}

const ATTACH_TIMEOUT_MS = 10_000;

/** A server instance: a restart (new pid or start time) is a new identity. */
const serverIdentity = (server: RunningLocalServer): string =>
  `${server.environmentId}\u0000${server.pid}\u0000${server.startedAt}`;

function toWebSocketBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export class DesktopAttachedPrimary extends Context.Service<
  DesktopAttachedPrimary,
  {
    /**
     * Attach exactly one server as the primary. `environmentId` selects
     * explicitly; `"auto"` attaches when discovery finds exactly one server
     * and drops to hosted-static (none attached) otherwise; `"none"` detaches.
     */
    readonly attach: (
      selection: string,
    ) => Effect.Effect<Option.Option<RunningLocalServer>, DesktopAttachedPrimaryError>;
    /** Re-verify the attachment against live discovery; drops it when stale. */
    readonly current: Effect.Effect<Option.Option<RunningLocalServer>>;
    /** One main-held bearer per attachment; re-mints when the server rejects it. */
    readonly getBearerToken: Effect.Effect<string, DesktopAttachedPrimaryError>;
    readonly snapshot: Effect.Effect<Option.Option<DesktopAttachedPrimarySnapshot>>;
    /**
     * Sync-safe read for the bootstrap IPC: the last verified server, or
     * none. Never runs discovery itself; `refresh` advances it asynchronously.
     */
    readonly cached: () => Option.Option<RunningLocalServer>;
    /** Re-verify in the background and advance the sync cache. */
    readonly refresh: Effect.Effect<Option.Option<RunningLocalServer>>;
    /**
     * Poll and focus refresh: re-verify a held attachment, or auto-attach
     * from empty so a server started after launch promotes.
     */
    readonly refreshOrAttach: Effect.Effect<
      Option.Option<RunningLocalServer>,
      DesktopAttachedPrimaryError
    >;
    /**
     * The renderer saw `bearerToken` fail (a transport error or a 401 that
     * survived one re-mint). A no-op unless that bearer is still the attached
     * one, so a late failure never drops a successor. Drops the attachment.
     * A transport error backs auto-attach off like a failed pair; an
     * `unauthorized` reject skips the instance until it restarts, so the
     * launch stays visibly hosted-static instead of flapping.
     */
    readonly reject: (
      bearerToken: string,
      reason: AttachedPrimaryRejectReason,
    ) => Effect.Effect<void>;
    /**
     * Auto-attach used once at client-only startup: attaches when discovery
     * finds exactly one server, otherwise leaves hosted-static. Idempotent:
     * a live attachment to the same server is kept.
     */
    readonly autoAttachOnStartup: Effect.Effect<
      Option.Option<RunningLocalServer>,
      DesktopAttachedPrimaryError
    >;
  }
>()("@t3tools/desktop/app/DesktopAttachedPrimary") {}

const ATTACH_RETRY_BASE_MS = 2_000;
const ATTACH_RETRY_MAX_MS = 60_000;

/** Exponential auto-attach retry after `failures` failed pairs: 2s, 4s, … capped at 60s. */
const attachRetryDelayMs = (failures: number) =>
  Math.min(ATTACH_RETRY_BASE_MS * 2 ** (failures - 1), ATTACH_RETRY_MAX_MS);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const discovery = yield* DesktopRunningLocalServers.DesktopRunningLocalServers;
  const httpClient = yield* HttpClient.HttpClient;
  // Plain cells, read and written synchronously so every check-then-write is
  // atomic. `generation` bumps on each drop: a publish that started under an
  // older generation discards itself instead of resurrecting or overwriting.
  const state: { current: AttachmentState | null } = { current: null };
  const cache: { current: CachedAttachedBootstrap | null } = { current: null };
  const generation = { current: 0 };
  // Server instances auto-attach skips: a 401 survived a re-mint, so its auth
  // is broken. A restart is a new identity, so it attaches again.
  const skipped = new Set<string>();
  // Auto-attach backoff per server instance after a failed verify, pair, or a
  // transport-error reject: every window's poll would otherwise re-run
  // `t3 pair` against it. Cleared on success; a restart is a new identity.
  const backoff = new Map<string, { readonly failures: number; readonly until: number }>();
  // One attach or mint at a time: parallel windows polling from empty and
  // parallel bearer reads each run discovery and `t3 pair` once, not per
  // caller. Detach and reject stay outside so they land under a held mint.
  const lock = yield* Semaphore.make(1);

  const verifyServer = (
    server: RunningLocalServer,
  ): Effect.Effect<RunningLocalServer, DesktopAttachedPrimaryUnavailableError> =>
    Effect.gen(function* () {
      const servers = yield* discovery.discover;
      const live = servers.find((candidate) => candidate.environmentId === server.environmentId);
      if (live === undefined) {
        return yield* new DesktopAttachedPrimaryUnavailableError({
          detail: `Attached server ${server.environmentId} is no longer running.`,
        });
      }
      // discover() verifies env id (persisted vs probed descriptor) and
      // endpoint reachability, but a restart on the SAME port keeps both.
      // Identity beyond the URL: pid + start time must match, and the live
      // descriptor must still report the attached env id. Anything else
      // means the server restarted away: never serve a stale primary.
      if (live.pid !== server.pid || live.startedAt !== server.startedAt) {
        return yield* new DesktopAttachedPrimaryUnavailableError({
          detail: `Attached server ${server.environmentId} restarted (pid or start time changed).`,
        });
      }
      const descriptor = yield* fetchDescriptorEnvironmentId(live);
      if (descriptor.environmentId !== server.environmentId) {
        return yield* new DesktopAttachedPrimaryUnavailableError({
          detail: "The attached server reported a different environment id on verify.",
        });
      }
      return live;
    });

  const mintBearerToken = (
    server: RunningLocalServer,
  ): Effect.Effect<string, DesktopAttachedPrimaryUnavailableError> =>
    Effect.gen(function* () {
      // The one-time pairing token the bundled `t3 pair` command mints is the
      // only credential an attached (non-spawned) server will accept: main
      // holds the resulting bearer and the renderer only ever sees that
      // bearer through the primary HTTP layer, never the pairing token.
      const pairing = yield* discovery.pairLocalServer(server.environmentId).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopAttachedPrimaryUnavailableError({
              detail: `Could not mint an attachment credential: ${cause.detail}`,
            }),
        ),
      );
      const token = new URL(pairing.pairingUrl).hash.match(/[#&?]token=([^&#]+)/)?.[1] ?? null;
      const credential = token === null ? "" : decodeURIComponent(token);
      if (credential.length === 0) {
        return yield* new DesktopAttachedPrimaryUnavailableError({
          detail: "The local pairing command returned an empty credential.",
        });
      }
      const session = yield* bootstrapRemoteBearerSession({
        httpBaseUrl: server.httpBaseUrl,
        credential,
        scopes: [...AuthStandardClientScopes],
        clientMetadata: { label: "T3 Code Desktop", deviceType: "desktop" },
        timeoutMs: ATTACH_TIMEOUT_MS,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.mapError(
          (cause) =>
            new DesktopAttachedPrimaryUnavailableError({
              detail: `The attached server rejected the attachment credential: ${String(cause)}`,
            }),
        ),
      );
      return session.access_token;
    });

  const fetchDescriptorEnvironmentId = (server: RunningLocalServer) =>
    fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: server.httpBaseUrl,
      timeoutMs: ATTACH_TIMEOUT_MS,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError(
        (cause) =>
          new DesktopAttachedPrimaryUnavailableError({
            detail: `Could not verify the attached server: ${String(cause)}`,
          }),
      ),
    );

  const dropNow = () => {
    generation.current += 1;
    state.current = null;
    cache.current = null;
  };

  const heldServer = () =>
    state.current === null ? Option.none<RunningLocalServer>() : Option.some(state.current.server);

  // A publish from an older generation lost a race: serve whatever the newer
  // attachment is (a restarted instance, or nothing) instead of failing it.
  const heldToken = Effect.suspend(() =>
    state.current === null
      ? Effect.fail(new DesktopAttachedPrimaryNotAttachedError())
      : Effect.succeed(state.current.bearerToken),
  );

  const detachNow = Effect.sync(() => {
    dropNow();
    return Option.none<RunningLocalServer>();
  });

  // The window starts when the failure lands, not when the attempt began, so
  // a slow failure (a descriptor timeout, a hung pair) still waits it out.
  const backOff = (failed: RunningLocalServer) =>
    Effect.map(Clock.currentTimeMillis, (failedAt) => {
      const identity = serverIdentity(failed);
      const failures = (backoff.get(identity)?.failures ?? 0) + 1;
      backoff.set(identity, { failures, until: failedAt + attachRetryDelayMs(failures) });
    });

  const attachLocked = (selection: string) =>
    Effect.gen(function* () {
      const started = generation.current;
      const servers = yield* discovery.discover;
      const explicit = selection !== ATTACHED_PRIMARY_SELECTION_AUTO;
      const now = yield* Clock.currentTimeMillis;
      const selected = explicit
        ? servers.find((candidate) => candidate.environmentId === selection)
        : servers.length === 1 &&
            !skipped.has(serverIdentity(servers[0]!)) &&
            (backoff.get(serverIdentity(servers[0]!))?.until ?? 0) <= now
          ? servers[0]
          : undefined;
      if (selected === undefined) {
        // None or several: stay hosted-static: only one verified server promotes
        // rather than guessing which server the user meant.
        if (generation.current === started) dropNow();
        return Option.none<RunningLocalServer>();
      }
      // Single flight: a caller that queued behind the attach that just
      // promoted this instance reuses it instead of pairing again.
      const held = state.current;
      if (held !== null && serverIdentity(held.server) === serverIdentity(selected)) {
        return Option.some(held.server);
      }
      const minted = yield* Effect.gen(function* () {
        const verified = yield* verifyServer(selected);
        return { verified, bearerToken: yield* mintBearerToken(verified) };
      }).pipe(Effect.tapError(() => (explicit ? Effect.void : backOff(selected))));
      backoff.delete(serverIdentity(selected));
      if (generation.current !== started) {
        return heldServer();
      }
      state.current = { selection, server: minted.verified, bearerToken: minted.bearerToken };
      cache.current = { server: minted.verified };
      return Option.some(minted.verified);
    });

  const attach: DesktopAttachedPrimary["Service"]["attach"] = (selection: string) =>
    selection === ATTACHED_PRIMARY_SELECTION_NONE
      ? detachNow
      : lock.withPermits(1)(attachLocked(selection));

  // Shared re-verify used by `current` and the background `refresh`: drops
  // the attachment (state + sync cache) whenever the live server no longer
  // matches, so a stale primary is never served.
  const reverify = Effect.gen(function* () {
    const started = generation.current;
    const held = state.current;
    if (held === null) {
      return Option.none<RunningLocalServer>();
    }
    const verified = yield* verifyServer(held.server).pipe(Effect.option);
    if (generation.current !== started) {
      // Something newer dropped or replaced the attachment meanwhile.
      return heldServer();
    }
    if (Option.isNone(verified) || verified.value.httpBaseUrl !== held.server.httpBaseUrl) {
      dropNow();
      return Option.none<RunningLocalServer>();
    }
    cache.current = { server: verified.value };
    return Option.some(verified.value);
  });

  const current: DesktopAttachedPrimary["Service"]["current"] = reverify;

  const cached: DesktopAttachedPrimary["Service"]["cached"] = () =>
    cache.current === null ? Option.none() : Option.some(cache.current.server);

  const refresh: DesktopAttachedPrimary["Service"]["refresh"] = reverify;

  const refreshOrAttach: DesktopAttachedPrimary["Service"]["refreshOrAttach"] = Effect.gen(
    function* () {
      const live = yield* reverify;
      if (Option.isSome(live)) {
        return live;
      }
      return yield* attach(ATTACHED_PRIMARY_SELECTION_AUTO);
    },
  );

  // Only the attachment that minted `bearerToken` can be rejected: a late
  // failure from a replaced instance must not blacklist its healthy successor.
  // A transport error may be one reset: back off and pair again. A 401 that
  // survived a re-mint means broken auth: skip the instance until it restarts.
  const reject: DesktopAttachedPrimary["Service"]["reject"] = (bearerToken, reason) =>
    Effect.suspend(() => {
      const held = state.current;
      if (held === null || held.bearerToken !== bearerToken) return Effect.void;
      dropNow();
      if (reason === "unauthorized") {
        skipped.add(serverIdentity(held.server));
        return Effect.void;
      }
      return backOff(held.server);
    });

  const autoAttachOnStartup: DesktopAttachedPrimary["Service"]["autoAttachOnStartup"] =
    refreshOrAttach;

  // Under the lock: the first reader holding a dead bearer re-mints and
  // parallel readers queue, then find the fresh token already stored. A mint
  // that raced a drop sees the bumped generation and serves the newer
  // attachment (or none) instead of resurrecting the dropped one. A mint
  // failure drops the attachment so the renderer falls back to hosted-static.
  const readLocked = (probedToken: string | null) =>
    Effect.gen(function* () {
      const started = generation.current;
      const held = state.current;
      if (held === null) {
        return yield* new DesktopAttachedPrimaryNotAttachedError();
      }
      if (probedToken !== null && held.bearerToken !== probedToken) {
        return held.bearerToken;
      }
      const live = yield* reverify;
      if (generation.current !== started || Option.isNone(live)) {
        return yield* heldToken;
      }
      const session = yield* fetchRemoteSessionState({
        httpBaseUrl: live.value.httpBaseUrl,
        bearerToken: held.bearerToken,
        timeoutMs: ATTACH_TIMEOUT_MS,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.option);
      if (Option.isSome(session) && session.value.authenticated) {
        return held.bearerToken;
      }
      const bearerToken = yield* mintBearerToken(live.value).pipe(Effect.option);
      if (generation.current !== started) {
        return yield* heldToken;
      }
      if (Option.isNone(bearerToken)) {
        dropNow();
        return yield* new DesktopAttachedPrimaryNotAttachedError();
      }
      state.current = {
        selection: held.selection,
        server: live.value,
        bearerToken: bearerToken.value,
      };
      return bearerToken.value;
    });

  const getBearerToken: DesktopAttachedPrimary["Service"]["getBearerToken"] = Effect.suspend(() =>
    lock.withPermits(1)(readLocked(state.current?.bearerToken ?? null)),
  );

  const snapshot: DesktopAttachedPrimary["Service"]["snapshot"] = Effect.gen(function* () {
    const live = yield* current;
    return Option.map(live, (server) => ({ server }) satisfies DesktopAttachedPrimarySnapshot);
  });

  return DesktopAttachedPrimary.of({
    attach,
    current,
    getBearerToken,
    snapshot,
    cached,
    refresh,
    refreshOrAttach,
    reject,
    autoAttachOnStartup,
  });
});

export const layer = Layer.effect(
  DesktopAttachedPrimary,
  Effect.gen(function* () {
    const discovery = yield* DesktopRunningLocalServers.DesktopRunningLocalServers;
    const httpClient = yield* HttpClient.HttpClient;
    return yield* make.pipe(
      Effect.provideService(DesktopRunningLocalServers.DesktopRunningLocalServers, discovery),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
  }),
);

/**
 * The service, only in client-only backend mode: managed mode owns its
 * backend and never attaches, so its bearer path stays unchanged.
 */
export const attachedPrimaryInClientOnly = Effect.gen(function* () {
  if ((yield* DesktopBackendMode.effectiveModeOrManaged) !== "client-only") {
    return Option.none<DesktopAttachedPrimary["Service"]>();
  }
  return yield* Effect.serviceOption(DesktopAttachedPrimary);
});

/**
 * Client-only startup attach (RSI-Software/t3code-hyprws#1350): attaches when
 * discovery finds exactly one server. Best-effort: any failure logs and keeps
 * hosted-static rather than failing startup.
 */
export const attachAtStartup = () =>
  attachedPrimaryInClientOnly.pipe(
    Effect.flatMap((attached) =>
      Option.isNone(attached)
        ? Effect.succeed(Option.none<RunningLocalServer>())
        : attached.value.autoAttachOnStartup,
    ),
    Effect.tap((result) =>
      Option.isSome(result)
        ? Effect.logInfo("bootstrap attached local server as primary", {
            environmentId: result.value.environmentId,
          })
        : Effect.logInfo("bootstrap no attachable local server; staying hosted-static"),
    ),
    Effect.catchCause((cause) => Effect.logWarning("bootstrap attach skipped", cause)),
    Effect.asVoid,
  );

export function attachedBootstrapOf(server: RunningLocalServer) {
  return {
    id: server.environmentId,
    label: server.label,
    lifecycle: "attached" as const,
    environmentId: server.environmentId,
    httpBaseUrl: server.httpBaseUrl,
    wsBaseUrl: toWebSocketBaseUrl(server.httpBaseUrl),
  };
}

/** The attached bearer, when a client-only launch holds a live attachment. */
export const attachedBearerToken = attachedPrimaryInClientOnly.pipe(
  Effect.flatMap((attached) =>
    Option.isNone(attached)
      ? Effect.succeed(Option.none<string>())
      : Effect.gen(function* () {
          // The sync cache, not `current`: the bearer read re-verifies once itself.
          if (Option.isNone(attached.value.cached())) return Option.none<string>();
          return Option.some(yield* attached.value.getBearerToken);
        }),
  ),
);

/** Whether an attached server is the primary; pickers stay usable then. */
export const isAttached = attachedPrimaryInClientOnly.pipe(
  Effect.flatMap((attached) =>
    Option.isNone(attached)
      ? Effect.succeed(false)
      : Effect.map(attached.value.current, Option.isSome),
  ),
);
