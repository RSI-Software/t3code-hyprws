import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));
const makeRepositoryIdentityResolverTestLayer = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.make({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));
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
});
