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
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_THREAD_GROUP_TITLE_TIMEOUT_MS = 60_000;

export const fetchEnvironmentThreadGroupTitle = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadGroupTitle",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ThreadGroupTitleGenerationInput;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = makeEnvironmentHttpApiUrlBuilder(
    input.prepared.httpBaseUrl,
  ).orchestration.generateThreadGroupTitle();
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_THREAD_GROUP_TITLE_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.generateThreadGroupTitle({ payload: input.request, headers }),
    ),
  );
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
