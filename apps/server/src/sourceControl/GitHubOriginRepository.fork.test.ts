import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubSourceControlProvider from "@t3tools/source-control-github/server/GitHubSourceControlProvider";

it.effect.each(["github.com", "enterprise.test"])(
  "keeps PR reads and writes on the selected origin at %s",
  (host) => {
    const restCalls: GitHubApi.GitHubRestInput[] = [];
    const graphqlCalls: GitHubApi.GitHubGraphQlInput[] = [];
    const context = {
      provider: { kind: "github" as const, name: "GitHub", baseUrl: `https://${host}` },
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
      isCrossRepository: false,
      updatedAt: "2026-01-01T00:00:00Z",
      headRefOid: "a".repeat(40),
      headRepository: { name: "t3code-hyprws", nameWithOwner: "rsi-software/t3code-hyprws" },
      headRepositoryOwner: { login: "rsi-software" },
    };
    const layer = Layer.mergeAll(
      Layer.mock(GitHubApi.GitHubApi)({
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
        graphql: (input) =>
          Effect.sync(() => {
            graphqlCalls.push(input);
            return JSON.stringify({
              data: {
                repository:
                  input.operation === "listPullRequestsByHead"
                    ? { h0: { nodes: [node] }, h1: { nodes: [] } }
                    : { pullRequest: node },
              },
            });
          }),
      }),
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
      for (const request of graphqlCalls) {
        assert.strictEqual(request.host, host);
        assert.strictEqual(request.variables?.owner, "rsi-software");
        assert.strictEqual(request.variables?.name, "t3code-hyprws");
      }
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Environment, { GH_REPO: "upstream/other" }),
    );
  },
);
