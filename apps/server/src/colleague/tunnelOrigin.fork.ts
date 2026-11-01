import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import { isLoopbackHost } from "../startupAccess.ts";

// cloudflared's metrics server binds the first free port of this range unless told otherwise.
const CLOUDFLARED_METRICS_PORTS = [20241, 20242, 20243, 20244, 20245];
const METRICS_REQUEST_TIMEOUT = Duration.millis(500);

// `/config` holds the ingress rules the edge pushed, as ManagedEndpointRuntime reads them.
const TunnelConfigBody = Schema.Struct({
  config: Schema.Struct({
    ingress: Schema.optional(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            hostname: Schema.optional(Schema.String),
            path: Schema.optional(Schema.String),
            service: Schema.optional(Schema.String),
          }),
        ),
      ),
    ),
  }),
});
type TunnelConfig = typeof TunnelConfigBody.Type;

const servesPort = (service: string | undefined, port: number) => {
  if (service === undefined || !URL.canParse(service)) return false;
  const url = new URL(service);
  const servicePort = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return isLoopbackHost(url.hostname) && servicePort === port;
};

// A rule hostname is exact or `*.suffix`; an empty one or a bare `*` matches every host.
const ruleMatches = (ruleHostname: string | undefined, hostname: string) =>
  ruleHostname === undefined ||
  ruleHostname === "" ||
  ruleHostname === "*" ||
  ruleHostname === hostname ||
  (ruleHostname.startsWith("*.") && hostname.endsWith(ruleHostname.slice(1)));

/**
 * The https origin of an exact hostname whose whole-host rule reaches this server's port.
 * cloudflared takes the first matching rule, so any earlier rule for that hostname that routes
 * elsewhere, by path or not, could take the pairing page and disqualifies it.
 */
const tunnelOriginForPort = (config: TunnelConfig, port: number): string | undefined => {
  const ingress = config.config.ingress ?? [];
  const rule = ingress.find(
    ({ hostname, path, service }, at) =>
      hostname !== undefined &&
      hostname !== "" &&
      !hostname.includes("*") &&
      (path === undefined || path === "") &&
      servesPort(service, port) &&
      ingress
        .slice(0, at)
        .every(
          (earlier) =>
            !ruleMatches(earlier.hostname, hostname) || servesPort(earlier.service, port),
        ),
  );
  return rule === undefined ? undefined : `https://${rule.hostname}`;
};

/** Asks each local cloudflared which public hostname routes to `port`. */
export const discoverTunnelOrigin = Effect.fn("discoverTunnelOrigin")(function* (port: number) {
  const httpClient = yield* HttpClient.HttpClient;
  const origins = yield* Effect.forEach(
    CLOUDFLARED_METRICS_PORTS,
    (metricsPort) =>
      httpClient.get(`http://127.0.0.1:${metricsPort}/config`).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(TunnelConfigBody)),
        Effect.scoped,
        Effect.withTracerEnabled(false),
        Effect.timeoutOption(METRICS_REQUEST_TIMEOUT),
        Effect.map(
          Option.flatMap((config) => Option.fromNullishOr(tunnelOriginForPort(config, port))),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
    { concurrency: "unbounded" },
  );
  return Option.getOrUndefined(Option.firstSomeOf(origins));
});
