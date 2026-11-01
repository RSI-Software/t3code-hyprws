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

/** The https origin of the first exact ingress hostname that routes to this server's port. */
const tunnelOriginForPort = (config: TunnelConfig, port: number): string | undefined => {
  const rule = config.config.ingress?.find(
    (entry) =>
      entry.hostname !== undefined &&
      entry.hostname !== "" &&
      !entry.hostname.includes("*") &&
      servesPort(entry.service, port),
  );
  return rule?.hostname === undefined ? undefined : `https://${rule.hostname}`;
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
