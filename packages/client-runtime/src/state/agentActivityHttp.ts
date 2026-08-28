import type {
  OrchestrationAgentActivitySnapshot,
  OrchestrationAgentActivityWindow,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const DEFAULT_AGENT_ACTIVITY_TIMEOUT_MS = 6_000;

export interface AgentActivityRequest extends OrchestrationAgentActivityWindow {
  readonly threadId: ThreadId;
  readonly agentId: string;
}

export const fetchEnvironmentAgentActivity = Effect.fn(
  "clientRuntime.state.fetchEnvironmentAgentActivity",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: AgentActivityRequest;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  const params = { threadId: input.request.threadId, agentId: input.request.agentId };
  const payload = {
    ...(input.request.limit === undefined ? {} : { limit: input.request.limit }),
    ...(input.request.beforeCursor === undefined
      ? {}
      : { beforeCursor: input.request.beforeCursor }),
  };
  const query = new URLSearchParams();
  if (input.request.limit !== undefined) {
    query.set("limit", String(input.request.limit));
  }
  if (input.request.beforeCursor !== undefined) {
    query.set("beforeCursor", input.request.beforeCursor);
  }
  const queryString = query.toString();
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    method: "GET",
    url: (httpBaseUrl) => {
      const base = environmentEndpointUrl(
        httpBaseUrl,
        `/api/orchestration/threads/${input.request.threadId}/agents/${input.request.agentId}/activities`,
      );
      return queryString === "" ? base : `${base}?${queryString}`;
    },
    timeoutMs: input.timeoutMs ?? DEFAULT_AGENT_ACTIVITY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.orchestration.agentActivity({
        params,
        payload,
        headers,
      }),
  });
});

export class AgentActivityLoader extends Context.Service<
  AgentActivityLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      request: AgentActivityRequest,
    ) => Effect.Effect<OrchestrationAgentActivitySnapshot, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/agentActivityHttp/AgentActivityLoader") {}

export const agentActivityLoaderLayer: Layer.Layer<
  AgentActivityLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  AgentActivityLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return AgentActivityLoader.of({
      load: (prepared, request) =>
        fetchEnvironmentAgentActivity({ prepared, request, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
