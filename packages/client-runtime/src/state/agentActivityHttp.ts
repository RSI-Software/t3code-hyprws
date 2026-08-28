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
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

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
  readonly timeoutMs?: number;
}) {
  const params = { threadId: input.request.threadId, agentId: input.request.agentId };
  const payload = {
    ...(input.request.limit === undefined ? {} : { limit: input.request.limit }),
    ...(input.request.beforeCursor === undefined
      ? {}
      : { beforeCursor: input.request.beforeCursor }),
  };
  const requestUrl = new URL(
    makeEnvironmentHttpApiUrlBuilder(input.prepared.httpBaseUrl).orchestration.agentActivity({
      params,
    }),
  );
  if (input.request.limit !== undefined) {
    requestUrl.searchParams.set("limit", String(input.request.limit));
  }
  if (input.request.beforeCursor !== undefined) {
    requestUrl.searchParams.set("beforeCursor", input.request.beforeCursor);
  }
  const authenticatedRequestUrl = requestUrl.toString();
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    authenticatedRequestUrl,
    input.signer,
  );

  return yield* executeEnvironmentHttpRequest(
    authenticatedRequestUrl,
    input.timeoutMs ?? DEFAULT_AGENT_ACTIVITY_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.agentActivity({
        params,
        payload,
        headers,
      }),
    ),
  );
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
    return AgentActivityLoader.of({
      load: (prepared, request) =>
        fetchEnvironmentAgentActivity({ prepared, request, signer }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
