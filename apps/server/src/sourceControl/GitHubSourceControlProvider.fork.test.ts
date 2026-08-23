import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

function makeProvider(github: Partial<GitHubCli.GitHubCli["Service"]>) {
  return GitHubSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(GitHubCli.GitHubCli)(github)),
  );
}

it.effect("reads a pull request on the context's own repository", () =>
  Effect.gen(function* () {
    let getInput: Parameters<GitHubCli.GitHubCli["Service"]["getPullRequest"]>[0] | null = null;
    const provider = yield* makeProvider({
      getPullRequest: (input) => {
        getInput = input;
        return Effect.succeed({
          number: 42,
          title: "Add GitHub provider",
          url: "https://github.com/RSI-Software/t3code-hyprws/pull/42",
          baseRefName: "hyprws",
          headRefName: "feature/source-control",
          state: "open",
        });
      },
    });

    yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
      context: {
        provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
        remoteName: "origin",
        remoteUrl: "git@github.com:RSI-Software/t3code-hyprws.git",
      },
    });

    assert.deepStrictEqual(getInput, {
      cwd: "/repo",
      reference: "42",
      rateLimitHost: "github.com",
      repository: "github.com/rsi-software/t3code-hyprws",
    });
  }),
);
