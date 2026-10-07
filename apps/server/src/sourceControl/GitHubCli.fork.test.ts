// Fork-owned: explicit-repository scoping for GitHubCli reads, adapted to the
// API-based service — `createPullRequest` and `getDefaultBranch` answer over
// REST, and `listPullRequestsByHead` carries the explicit repository in its
// GraphQL variables instead of a `--repo` argv flag.
import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCli from "./GitHubCli.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const restResponse = (body: unknown, status = 200): GitHubApi.GitHubRestResponse => ({
  status,
  headers: {},
  body: JSON.stringify(body),
  truncated: false,
  invalidUtf8: false,
});

/** One read a test can assert on, without any cwd remote consultation. */
function harness(input: {
  readonly graphql?: GitHubApi.GitHubApi["Service"]["graphql"];
  readonly rest?: GitHubApi.GitHubApi["Service"]["rest"];
  readonly bodyFile?: string;
}) {
  const gitRuns: Array<ReadonlyArray<string>> = [];
  const bodyFile = input.bodyFile;
  const driver = Layer.mock(GitVcsDriver.GitVcsDriver)({
    execute: (args) =>
      Effect.sync(() => {
        gitRuns.push(["execute", ...args.args]);
        return processOutput("");
      }),
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    readConfigValue: () => Effect.succeed("git@github.com:acme/web.git"),
  });
  const process = Layer.mock(VcsProcess.VcsProcess)({
    run: (args) =>
      Effect.sync(() => {
        gitRuns.push([args.command, ...args.args]);
        return processOutput("");
      }),
  });
  const layer = Layer.effect(GitHubCli.GitHubCli, GitHubCli.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        driver,
        process,
        Layer.mock(GitHubApi.GitHubApi)({
          ...(input.graphql === undefined ? {} : { graphql: input.graphql }),
          ...(input.rest === undefined ? {} : { rest: input.rest }),
        }),
        NodeServices.layer,
        // Last wins over NodeServices' real file system: the body file is fixture content.
        ...(bodyFile === undefined
          ? []
          : [FileSystem.layerNoop({ readFileString: () => Effect.succeed(bodyFile) })]),
      ),
    ),
  );
  return { layer, gitRuns };
}

describe("GitHubCli.make", () => {
  it.effect("scopes PR creation and default branch lookup to an explicit repository", () => {
    const restCalls: Array<GitHubApi.GitHubRestInput> = [];
    const { layer, gitRuns } = harness({
      bodyFile: "PR body",
      rest: (input) => {
        restCalls.push(input);
        return Effect.succeed(
          restResponse(
            input.method === "POST"
              ? {}
              : {
                  full_name: "rsi-software/t3code-hyprws",
                  html_url: "https://github.com/rsi-software/t3code-hyprws",
                  ssh_url: "git@github.com:rsi-software/t3code-hyprws.git",
                  default_branch: "hyprws",
                },
          ),
        );
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.createPullRequest({
        cwd: "/repo",
        baseBranch: "hyprws",
        headSelector: "feature/origin-pr",
        title: "Origin PR",
        bodyFile: "/tmp/body.md",
        repository: "github.com/rsi-software/t3code-hyprws",
      });
      const defaultBranch = yield* gh.getDefaultBranch({
        cwd: "/repo",
        repository: "github.com/rsi-software/t3code-hyprws",
      });
      assert.strictEqual(defaultBranch, "hyprws");
      const create = restCalls[0];
      assert.strictEqual(create?.method, "POST");
      assert.strictEqual(create?.host, "github.com");
      assert.strictEqual(create?.path, "repos/rsi-software/t3code-hyprws/pulls");
      assert.deepStrictEqual(create?.body, {
        base: "hyprws",
        head: "feature/origin-pr",
        title: "Origin PR",
        body: "PR body",
        maintainer_can_modify: true,
      });
      const read = restCalls[1];
      assert.strictEqual(read?.path, "repos/rsi-software/t3code-hyprws");
      // An explicit repository is parsed, never resolved through the checkout's remotes.
      assert.deepStrictEqual(gitRuns, []);
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubCli.listPullRequestsByHead", () => {
  const byHeadAnswer = () =>
    Effect.succeed(
      JSON.stringify({
        data: {
          repository: {
            h0: {
              nodes: [
                {
                  number: 7,
                  title: "A",
                  state: "OPEN",
                  headRefName: "feature/a",
                  headRepositoryOwner: { login: "me" },
                  baseRefName: "hyprws",
                  url: "https://github.com/me/web/pull/7",
                  author: { login: "me" },
                  updatedAt: "2026-01-01T00:00:00Z",
                  headRefOid: "a".repeat(40),
                },
              ],
            },
            h1: { nodes: [] },
          },
        },
      }),
    );

  it.effect("reads an explicit repository instead of the one gh would pick", () => {
    const documents: Array<GitHubApi.GitHubGraphQlInput> = [];
    const { layer, gitRuns } = harness({
      graphql: (input) => {
        documents.push(input);
        return byHeadAnswer();
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const lookup = yield* GitHubApi.AllowGitHubReserve.pipe(
        Effect.flatMap(() =>
          gh.listPullRequestsByHead({
            cwd: "/repo",
            headSelector: "feature/a",
            state: "all",
            limit: 100,
            rateLimitHost: "github.com",
            repository: "github.com/me/web",
          }),
        ),
        Effect.provideService(GitHubApi.AllowGitHubReserve, true),
        Effect.forkChild,
      );
      yield* TestClock.adjust("50 millis");
      const joined = yield* Fiber.join(lookup);
      assert.deepStrictEqual(gitRuns, []);
      assert.deepStrictEqual(
        joined?.map((pr) => pr.number),
        [7],
      );
      assert.strictEqual(documents[0]?.host, "github.com");
      assert.deepStrictEqual(
        [documents[0]?.variables?.owner, documents[0]?.variables?.name],
        ["me", "web"],
      );

      const enterpriseLookup = yield* GitHubApi.AllowGitHubReserve.pipe(
        Effect.flatMap(() =>
          gh.listPullRequestsByHead({
            cwd: "/repo",
            headSelector: "feature/a",
            state: "all",
            limit: 100,
            rateLimitHost: "github.com",
            repository: "enterprise.test/me/web",
          }),
        ),
        Effect.provideService(GitHubApi.AllowGitHubReserve, true),
        Effect.forkChild,
      );
      yield* TestClock.adjust("50 millis");
      yield* Fiber.join(enterpriseLookup);
      assert.strictEqual(documents[1]?.host, "enterprise.test");
      assert.deepStrictEqual(
        [documents[1]?.variables?.owner, documents[1]?.variables?.name],
        ["me", "web"],
      );
    }).pipe(Effect.provide(layer));
  });
});
