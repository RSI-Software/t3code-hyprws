import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWindowSession from "./DesktopWindowSession.ts";
import { HyprlandPlacement } from "./HyprlandPlacement.ts";
import type { HyprlandWorkspaceRef } from "./hyprland.ts";
import { HUB_WINDOW_IDENTITY, projectWindowIdentity } from "./WindowIdentity.ts";

const projectIdentity = projectWindowIdentity(
  EnvironmentId.make("environment-1"),
  ProjectId.make("project-1"),
);

function makeLayer(baseDir: string, workspaces: Record<string, HyprlandWorkspaceRef>) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

  const placementLayer = Layer.succeed(HyprlandPlacement, {
    isAvailable: true,
    claim: () => Effect.void,
    forget: () => Effect.void,
    workspaceOf: (key) => Effect.succeed(Option.fromNullishOr(workspaces[key])),
    stageWorkspaceRule: () => Effect.succeed(false),
    clearWorkspaceRule: () => Effect.void,
    moveToWorkspace: () => Effect.void,
  } satisfies HyprlandPlacement["Service"]);

  return DesktopWindowSession.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(environmentLayer, placementLayer, NodeServices.layer)),
  );
}

const withSession = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopWindowSession.DesktopWindowSession>,
  workspaces: Record<string, HyprlandWorkspaceRef> = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-window-session-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, workspaces)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopWindowSession", () => {
  it.effect("round-trips the open windows with the workspace each one occupied", () =>
    withSession(
      Effect.gen(function* () {
        const session = yield* DesktopWindowSession.DesktopWindowSession;
        yield* session.capture([HUB_WINDOW_IDENTITY, projectIdentity], "update");

        assert.deepEqual(yield* session.consume, [
          { identity: HUB_WINDOW_IDENTITY, workspace: { id: 1, name: "1" } },
          { identity: projectIdentity, workspace: { id: 4, name: "code" } },
        ]);
      }),
      {
        hub: { id: 1, name: "1" },
        "project:environment-1:project-1": { id: 4, name: "code" },
      },
    ),
  );

  it.effect("consumes once, so a normal relaunch never resurrects windows", () =>
    withSession(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const session = yield* DesktopWindowSession.DesktopWindowSession;
        yield* session.capture([projectIdentity], "update");

        assert.lengthOf(yield* session.consume, 1);
        assert.isFalse(yield* fileSystem.exists(environment.windowSessionPath));
        assert.deepEqual(yield* session.consume, []);
      }),
    ),
  );

  it.effect("captures nothing when no window is open", () =>
    withSession(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const session = yield* DesktopWindowSession.DesktopWindowSession;
        yield* session.capture([], "update");

        assert.isFalse(yield* fileSystem.exists(environment.windowSessionPath));
      }),
    ),
  );

  it.effect("starts fresh instead of failing on an unreadable manifest", () =>
    withSession(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.windowSessionPath, "{ not json");
        const session = yield* DesktopWindowSession.DesktopWindowSession;

        assert.deepEqual(yield* session.consume, []);
        assert.isFalse(yield* fileSystem.exists(environment.windowSessionPath));
      }),
    ),
  );

  it("drops a manifest an abandoned install left behind", () => {
    const document = {
      version: 1,
      reason: "update",
      capturedAtMs: 1_000,
      windows: [{ kind: "hub" as const, workspace: null }],
    };
    assert.lengthOf(DesktopWindowSession.readRestoreEntries(document, 2_000), 1);
    assert.lengthOf(
      DesktopWindowSession.readRestoreEntries(
        document,
        1_000 + DesktopWindowSession.WINDOW_SESSION_MAX_AGE_MS + 1,
      ),
      0,
    );
  });

  it("skips window rows that no longer name a project", () => {
    assert.deepEqual(
      DesktopWindowSession.readRestoreEntries(
        {
          version: 1,
          reason: "update",
          capturedAtMs: 1_000,
          windows: [
            { kind: "project", environmentId: "", projectId: "project-1", workspace: null },
            { kind: "project", environmentId: "environment-1", workspace: null },
            {
              kind: "project",
              environmentId: "environment-1",
              projectId: "project-1",
              workspace: null,
            },
          ],
        },
        1_500,
      ),
      [{ identity: projectIdentity, workspace: null }],
    );
  });
});
