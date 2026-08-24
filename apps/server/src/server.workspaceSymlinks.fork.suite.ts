// Fork-owned WebSocket cases for following external workspace symlinks.
// `server.test.ts` registers them inside its router seam suite through one
// hook, so they reuse its app harness without adding test blocks to the
// upstream file.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type * as NodeServices from "@effect/platform-node/NodeServices";
import type { Vitest } from "@effect/vitest";
import { assert } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { WorkspaceSymlinkHarnessFork } from "./server.test.ts";

export const workspaceSymlinkTestsFork = (
  it: Vitest.MethodsNonLive<NodeServices.NodeServices>,
  { buildAppUnderTest, getWsServerUrl, withWsRpcClient }: WorkspaceSymlinkHarnessFork,
) => {
  it.effect("reads external workspace symlinks when the global setting is enabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-external-link-",
      });
      const sharedDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-external-link-target-",
      });
      yield* fs.makeDirectory(path.join(sharedDir, "plans"), { recursive: true });
      yield* fs.writeFileString(path.join(sharedDir, "plans", "spec.md"), "# Shared plan\n");
      yield* fs.symlink(sharedDir, path.join(workspaceDir, ".dump"));

      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              followExternalWorkspaceSymlinks: true,
            }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsReadFile]({
            cwd: workspaceDir,
            relativePath: ".dump/plans/spec.md",
          }),
        ),
      );

      assert.deepEqual(response, {
        relativePath: ".dump/plans/spec.md",
        contents: "# Shared plan\n",
        byteLength: 14,
        truncated: false,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
};
