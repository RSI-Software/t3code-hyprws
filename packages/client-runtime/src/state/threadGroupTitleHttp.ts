import type {
  ThreadGroupTitleGenerationInput,
  ThreadGroupTitleGenerationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const DEFAULT_THREAD_GROUP_TITLE_TIMEOUT_MS = 60_000;

export const fetchEnvironmentThreadGroupTitle = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadGroupTitle",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ThreadGroupTitleGenerationInput;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    method: "POST",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/orchestration/thread-group-title"),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_GROUP_TITLE_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.orchestration.generateThreadGroupTitle({ payload: input.request, headers }),
  });
});

export class ThreadGroupTitleLoader extends Context.Service<
  ThreadGroupTitleLoader,
  {
    readonly generate: (
      prepared: PreparedConnection,
      input: ThreadGroupTitleGenerationInput,
    ) => Effect.Effect<ThreadGroupTitleGenerationResult, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/threadGroupTitleHttp/ThreadGroupTitleLoader") {}

export const threadGroupTitleLoaderLayer: Layer.Layer<
  ThreadGroupTitleLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadGroupTitleLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return ThreadGroupTitleLoader.of({
      generate: (prepared, request) =>
        fetchEnvironmentThreadGroupTitle({ prepared, request, signer }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
