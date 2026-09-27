import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubSourceControlProvider from "@t3tools/source-control-github/server/GitHubSourceControlProvider";

it.effect.each(["github.com", "enterprise.test"])(
  "keeps PR reads and writes on the selected origin at %s",
  (host) => {
    const restCalls: GitHubRest.GitHubRestInput[] = [];
    const graphqlCalls: Array<{
      readonly url: string;
      readonly variables: Readonly<Record<string, unknown>>;
    }> = [];
    const context = {
      provider: {
        kind: SourceControlProviderKind.make("github"),
        name: "GitHub",
        baseUrl: `https://${host}`,
      },
      remoteName: "origin",
      remoteUrl: "git@github-work:RSI-Software/t3code-hyprws.git",
      preferRemoteRepositoryFork: true,
    };
    const node = {
      number: 42,
      title: "Origin PR",
      url: `https://${host}/RSI-Software/t3code-hyprws/pull/42`,
      baseRefName: "hyprws",
      headRefName: "feature/origin-pr",
      state: "OPEN",
      isDraft: false,
      mergedAt: null,
      closedAt: null,
      isCrossRepository: false,
      updatedAt: "2026-01-01T00:00:00Z",
      headRefOid: "a".repeat(40),
      headRepository: { name: "t3code-hyprws", nameWithOwner: "rsi-software/t3code-hyprws" },
      headRepositoryOwner: { __typename: "Organization", login: "rsi-software" },
    };
    const signedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
      enabled: false,
      token: () => Effect.succeedNone,
      invalidate: () => Effect.void,
    });
    const layer = Layer.mergeAll(
      signedOut,
      Layer.mock(GitHubRest.GitHubRest)({
        rest: (input) =>
          Effect.sync(() => {
            restCalls.push(input);
            return {
              status: 200,
              headers: {},
              truncated: false,
              invalidUtf8: false,
              body: JSON.stringify(
                input.method === "POST"
                  ? {}
                  : {
                      full_name: "rsi-software/t3code-hyprws",
                      html_url: `https://${host}/rsi-software/t3code-hyprws`,
                      ssh_url: `git@${host}:rsi-software/t3code-hyprws.git`,
                      default_branch: "hyprws",
                    },
              ),
            };
          }),
      }),
      // GraphQL goes over HTTP through the real request policy; each answer is keyed by the
      // aliased `repository` a lookup reads, `_N_repository` when batched.
      GitHubRequestPolicy.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            signedOut,
            Layer.succeed(GitHubCredentials.GitHubCredentials, {
              get: (credentialHost) =>
                Effect.succeed({
                  host: credentialHost,
                  token: Redacted.make("token"),
                  source: "gh" as const,
                  fingerprint: `${credentialHost}:token`,
                }),
              saved: () => Effect.succeedNone,
              fingerprint: (credentialHost) => Effect.succeed(`${credentialHost}:token`),
              invalidate: () => Effect.void,
            }),
            GitHubQuota.layer,
            SourceControlRateLimit.layer,
          ),
        ),
      ),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const sent =
              request.body._tag === "Uint8Array"
                ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
                    readonly variables: Readonly<Record<string, unknown>>;
                  })
                : { variables: {} };
            graphqlCalls.push({ url: request.url, variables: sent.variables });
            const prefixes = [
              ...new Set(Object.keys(sent.variables).flatMap((key) => /^_\d+_/.exec(key) ?? [""])),
            ];
            const data = Object.fromEntries(
              prefixes.map((prefix) => [
                `${prefix}repository`,
                `${prefix}head` in sent.variables
                  ? { pullRequests: { nodes: [node] } }
                  : { pullRequest: node },
              ]),
            );
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ data }), {
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        ),
      ),
      TestSourceControlHost.layer({
        process: { run: () => Effect.die("unexpected git read") },
      }),
      NodeServices.layer,
      FileSystem.layerNoop({ readFileString: () => Effect.succeed("PR body") }),
    );
    return Effect.gen(function* () {
      const provider = yield* GitHubSourceControlProvider.make;
      const input = { cwd: "/repo", context };
      yield* provider.createChangeRequest({
        ...input,
        baseRefName: "hyprws",
        headSelector: "feature/origin-pr",
        title: "Origin PR",
        bodyFile: "/fixture/body.md",
      });
      assert.strictEqual(yield* provider.getDefaultBranch(input), "hyprws");
      assert.strictEqual(
        (yield* provider.getChangeRequest({ ...input, reference: "42" })).number,
        42,
      );
      const lookup = yield* provider
        .listChangeRequests({
          ...input,
          headSelector: "feature/origin-pr",
          state: "open",
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("50 millis");
      assert.deepStrictEqual(
        (yield* Fiber.join(lookup)).map((pr) => pr.number),
        [42],
      );
      assert.deepStrictEqual(
        restCalls.map(({ host, path }) => [host, path]),
        [
          [host, "repos/rsi-software/t3code-hyprws/pulls"],
          [host, "repos/rsi-software/t3code-hyprws"],
        ],
      );
      assert.deepStrictEqual(restCalls[0]?.body, {
        base: "hyprws",
        head: "feature/origin-pr",
        title: "Origin PR",
        body: "PR body",
        maintainer_can_modify: true,
      });
      assert.isNotEmpty(graphqlCalls);
      for (const request of graphqlCalls) {
        assert.include(new URL(request.url).hostname, host);
        for (const [key, value] of Object.entries(request.variables)) {
          if (key.endsWith("owner")) assert.strictEqual(value, "rsi-software");
          if (key.endsWith("name")) assert.strictEqual(value, "t3code-hyprws");
        }
      }
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Environment, { GH_REPO: "upstream/other" }),
    );
  },
);
