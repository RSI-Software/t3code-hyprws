// Fork-owned test sibling for `ServerEnvironment.test.ts`: the GitHub Issues
// capability that commit `9f92309411` (feat(issues): add GitHub Issues surface
// scoped to project windows) advertises through the marked hook
// `github-issues/server-environment-capability` in `ServerEnvironment.ts`.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "./ServerEnvironment.ts";

it.layer(NodeServices.layer)("ServerEnvironment fork", (it) => {
  const makeServerEnvironmentLayer = (baseDir: string) =>
    ServerEnvironment.layer.pipe(
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    );

  it.effect("advertises the read-only GitHub Issues capability", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-fork-test-",
      });
      const descriptor = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));

      expect(descriptor.capabilities.githubIssues).toBe(true);
    }),
  );
});
