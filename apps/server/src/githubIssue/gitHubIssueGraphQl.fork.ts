// Fork-only: the GitHub issue surface reads raw GraphQL documents. Upstream's `GitHubApi.graphql`
// went away with its move to generated effect/graphql documents (`#19224`), so this sends the
// same documents through upstream's `GitHubRequestPolicy`: one credential, slot pool, quota and
// pause with every other GitHub read.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface GitHubIssueGraphQlInput {
  readonly host: string;
  readonly operation: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

export class GitHubIssueGraphQl extends Context.Service<
  GitHubIssueGraphQl,
  {
    /** The raw JSON body of a successful answer; GitHub `errors` fail as the policy's errors. */
    readonly graphql: (
      input: GitHubIssueGraphQlInput,
    ) => Effect.Effect<string, GitHubRequestPolicy.GitHubApiError>;
  }
>()("t3/githubIssue/gitHubIssueGraphQl.fork/GitHubIssueGraphQl") {}

const decodeErrors = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      errors: Schema.NonEmptyArray(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/** GitHub fails a GraphQL document with HTTP 200 and an `errors` list, so the body decides too. */
function classify(input: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}): GitHubRequestPolicy.GitHubAnswer<string> {
  const { status, headers, body } = input;
  const meta = { status, headers };
  const errors = Option.getOrUndefined(decodeErrors(body))?.errors;
  if (
    GitHubRequestPolicy.isRateLimited({
      status,
      headers,
      body,
      ...(errors === undefined ? {} : { graphqlErrors: errors }),
    })
  ) {
    return { _tag: "RateLimited", ...meta };
  }
  if (status === 401) return { _tag: "Unauthorized", ...meta };
  if (status === 404 || errors?.every((error) => error.type === "NOT_FOUND") === true) {
    return { _tag: "NotFound", ...meta };
  }
  if (errors !== undefined) {
    const messages = errors.flatMap((error) =>
      error.message === undefined ? [] : [error.message],
    );
    return { _tag: "Failed", messages, ...meta };
  }
  if (status >= 200 && status < 300) return { _tag: "Ok", value: body, ...meta };
  return { _tag: "Failed", ...meta };
}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;

  const graphql: GitHubIssueGraphQl["Service"]["graphql"] = Effect.fn("GitHubIssueGraphQl.graphql")(
    function* (input) {
      const host = GitHubRequestPolicy.normalizeHost(input.host);
      const context = { host, operation: input.operation };
      const request = HttpClientRequest.post(GitHubRequestPolicy.gitHubApiUrls(host).graphql).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJsonUnsafe({ query: input.query, variables: input.variables ?? {} }),
      );
      const allowReserve = yield* SourceControlRateLimit.Interactive;
      return yield* policy.request({ ...context, resource: "graphql", allowReserve }, (headers) =>
        Effect.gen(function* () {
          const response = yield* httpClient.execute(
            request.pipe(HttpClientRequest.setHeaders(headers)),
          );
          const collected = yield* collectUint8StreamText({
            stream: response.stream,
            maxBytes: MAX_RESPONSE_BYTES,
          });
          // A body cut at the byte cap hides any `errors` past the cut and cannot be decoded.
          if (collected.truncated) {
            return { _tag: "Failed", status: response.status, headers: response.headers } as const;
          }
          return classify({
            status: response.status,
            headers: response.headers,
            body: collected.text,
          });
        }).pipe(
          Effect.mapError(
            (cause) => new GitHubRequestPolicy.GitHubApiRequestError({ ...context, cause }),
          ),
        ),
      );
    },
  );

  return GitHubIssueGraphQl.of({ graphql });
});

export const layer = Layer.effect(GitHubIssueGraphQl, make);
