// Attached-primary renderer seam (RSI-Software/t3code-hyprws#1350): a
// client-only desktop launch adopts exactly one verified local server as its
// primary. Main holds the pairing token and mints the bearer; the renderer
// only reads that bearer, reports it dead, and asks main to refresh.
import type { AttachedPrimaryRejectReason } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Headers, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { readDesktopPrimaryBearerToken, resetDesktopPrimaryBearerTokenCache } from "./desktopAuth";
import type { PrimaryEnvironmentTarget } from "./target";

function isClientOnly(): boolean {
  return window.desktopBridge?.getBackendModeState?.().effectiveMode === "client-only";
}

/**
 * The attached server as the primary target, or null. The sync bridge read
 * serves main's last verified cache; the platform poll advances it, so a
 * restarted, moved, or rejected server converges to hosted-static. The
 * source reads `desktop-managed`: the backend is local either way, and only
 * main distinguishes adopted from spawned.
 */
export function resolveDesktopAttachedPrimaryTarget(): PrimaryEnvironmentTarget | null {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge?.getAttachedPrimaryBootstrap || !isClientOnly()) {
    return null;
  }
  try {
    const bootstrap = bridge.getAttachedPrimaryBootstrap();
    if (bootstrap?.lifecycle !== "attached" || !bootstrap.httpBaseUrl || !bootstrap.wsBaseUrl) {
      return null;
    }
    // Absolute URLs only: a client-only renderer's origin is opaque.
    return {
      source: "desktop-managed",
      target: {
        httpBaseUrl: new URL(bootstrap.httpBaseUrl).toString(),
        wsBaseUrl: new URL(bootstrap.wsBaseUrl).toString(),
      },
    };
  } catch {
    return null;
  }
}

/** A desktop bridge that can attach a running local server as the primary. */
export function hasAttachBridge(): boolean {
  return window.desktopBridge?.refreshAttachedPrimaryBootstrap !== undefined;
}

/** Ask main to re-verify the attachment, or attach a server started later. */
export function refreshAttachedPrimary(): Promise<unknown> {
  const bridge = window.desktopBridge;
  if (!bridge?.refreshAttachedPrimaryBootstrap || !isClientOnly()) {
    return Promise.resolve(null);
  }
  return bridge.refreshAttachedPrimaryBootstrap().catch(() => null);
}

/** Drop the cached bearer and read a fresh one; main re-verifies and re-mints. */
export function invalidateAttachedPrimaryBearerToken(): Promise<string | null> {
  resetDesktopPrimaryBearerTokenCache();
  return readDesktopPrimaryBearerToken().catch(() => null);
}

/**
 * The bearer is dead for good: main drops the attachment, the launch goes
 * hosted-static. Carries the bearer that failed so main ignores a late report
 * against an attachment it already replaced.
 */
function rejectAttachedPrimary(
  bearerToken: string | null,
  reason: AttachedPrimaryRejectReason,
): Promise<void> {
  resetDesktopPrimaryBearerTokenCache();
  const reject = window.desktopBridge?.rejectAttachedPrimary;
  return reject && bearerToken !== null
    ? reject(bearerToken, reason).catch(() => undefined)
    : Promise.resolve();
}

const rejectEffect = (bearerToken: string | null, reason: AttachedPrimaryRejectReason) =>
  Effect.promise(() => rejectAttachedPrimary(bearerToken, reason));

/**
 * The bearer the failed request actually carried. `transform` sees the request
 * after the bearer-injecting preprocess, so this never reads the cache, which a
 * concurrent 401 may already have refilled for a successor.
 */
function sentBearer(request: HttpClientRequest.HttpClientRequest): string | null {
  const authorization = Headers.get(request.headers, "authorization");
  return Option.isSome(authorization) && authorization.value.startsWith("Bearer ")
    ? authorization.value.slice("Bearer ".length)
    : null;
}

/**
 * The primary connection broker's failure hook: a rejected WebSocket ticket
 * means the cached bearer is dead, so the next prepare re-reads through main.
 * A no-op unless the attached server is the primary.
 */
export const invalidateAttachedPrimaryBearer = (): Effect.Effect<void> =>
  resolveDesktopAttachedPrimaryTarget() === null
    ? Effect.void
    : Effect.asVoid(Effect.promise(invalidateAttachedPrimaryBearerToken));

/**
 * The attached-primary 401 contract, layered on the primary bearer client: a
 * 401 re-mints once and retries; a second 401 or a transport error rejects
 * the attachment. Managed desktop and browser primaries get `client` as is.
 */
export function withAttachedPrimaryRetry(client: HttpClient.HttpClient): HttpClient.HttpClient {
  if (typeof window === "undefined" || !isClientOnly()) {
    return client;
  }
  const retried: HttpClient.HttpClient = HttpClient.transform(client, (response, request) =>
    response.pipe(
      Effect.tapError((error) =>
        error.reason._tag === "TransportError" && resolveDesktopAttachedPrimaryTarget() !== null
          ? rejectEffect(sentBearer(request), "transport")
          : Effect.void,
      ),
      Effect.flatMap((first) =>
        first.status !== 401 || resolveDesktopAttachedPrimaryTarget() === null
          ? Effect.succeed(first)
          : Effect.promise(invalidateAttachedPrimaryBearerToken).pipe(
              Effect.flatMap((fresh) =>
                fresh === null
                  ? Effect.as(rejectEffect(sentBearer(request), "unauthorized"), first)
                  : client
                      .execute(HttpClientRequest.bearerToken(request, fresh))
                      .pipe(
                        Effect.tap((second) =>
                          second.status === 401 ? rejectEffect(fresh, "unauthorized") : Effect.void,
                        ),
                      ),
              ),
            ),
      ),
    ),
  );
  return retried;
}
