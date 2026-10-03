import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { forkSupersedes } from "../../../../scripts/lib/fork-supersedes.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));
it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("prefers origin over upstream when both remotes are configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-origin-test-",
      });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity).not.toBeNull();
      expect(identity?.locator.remoteName).toBe("origin");
      expect(identity?.canonicalKey).toBe("github.com/julius/t3code");
      expect(identity?.displayName).toBe("julius/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  forkSupersedes({
    upstream:
      "apps/server/src/project/RepositoryIdentityResolver.test.ts > refreshes the primary upstream after %s before cache expiry",
    reason:
      "the fork keeps origin as the primary remote, so adding or retargeting upstream never moves the identity off origin",
    commit: "d089901e993",
  });
  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary origin after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-origin-test-",
        });
        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.locator.remoteName).toBe("origin");
        expect(initialIdentity?.canonicalKey).toBe("github.com/julius/t3code");

        if (change === "add") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);
        } else {
          yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:T3Tools/t3code.git"]);
        }
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("origin");
        expect(identity?.canonicalKey).toBe(
          change === "add" ? "github.com/julius/t3code" : "github.com/t3tools/t3code",
        );
        expect(identity?.displayName).toBe(change === "add" ? "julius/t3code" : "t3tools/t3code");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );
});
