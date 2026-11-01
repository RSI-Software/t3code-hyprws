import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-fork-test-",
});
const layerTest = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
  WorkspacePaths.layer,
  ServerSettings.layerTest(),
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
  layerConfig,
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect.skipIf(!symlinksSupported)(
  "previews workspace files behind external symlinks only while the setting allows it",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const settings = yield* ServerSettings.ServerSettingsService;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-asset-worktree-" });
      const shared = yield* fs.makeTempDirectoryScoped({ prefix: "t3-asset-shared-dump-" });
      yield* fs.makeDirectory(path.join(shared, "notes"));
      yield* fs.writeFileString(path.join(shared, "notes", "map.html"), "<p>map</p>");
      yield* fs.writeFileString(path.join(shared, "notes", "map.css"), "p {}");
      yield* fs.writeFileString(path.join(shared, "notes", "shot.png"), "png");
      yield* fs.symlink(shared, path.join(root, ".dump"));
      const issue = (name: string) =>
        issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: path.join(root, ".dump", "notes", name),
          },
          workspaceRoot: root,
        }).pipe(
          Effect.map(({ relativeUrl }) => {
            const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
            return suffix.slice(0, suffix.indexOf("/"));
          }),
        );
      const canonical = (name: string) => fs.realPath(path.join(shared, "notes", name));

      expect(yield* issue("map.html").pipe(Effect.flip)).toMatchObject({
        _tag: "AssetWorkspaceAssetNotFoundError",
      });

      yield* settings.updateSettings({ followExternalWorkspaceSymlinks: true });
      const htmlToken = yield* issue("map.html");
      const pngToken = yield* issue("shot.png");
      expect(yield* resolveAsset(htmlToken, "map.html")).toEqual({
        kind: "file",
        path: yield* canonical("map.html"),
      });
      expect(yield* resolveAsset(htmlToken, "map.css")).toEqual({
        kind: "file",
        path: yield* canonical("map.css"),
      });
      expect(yield* resolveAsset(pngToken, "shot.png")).toEqual({
        kind: "file",
        path: yield* canonical("shot.png"),
      });

      yield* settings.updateSettings({ followExternalWorkspaceSymlinks: false });
      expect(yield* resolveAsset(htmlToken, "map.html")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
);
