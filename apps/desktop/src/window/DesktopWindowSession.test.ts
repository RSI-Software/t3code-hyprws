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
import type { WindowId } from "./WindowId.fork.ts";
import { HUB_WINDOW_IDENTITY, projectWindowIdentity } from "./WindowIdentity.ts";

const projectIdentity = projectWindowIdentity(
  EnvironmentId.make("environment-1"),
  ProjectId.make("project-1"),
);
const projectSeed = {
  environmentId: EnvironmentId.make("environment-1"),
  projectId: ProjectId.make("project-1"),
};
const hubWindowId = "00000000-0000-4000-8000-000000000001" as WindowId;
const projectWindowId = "00000000-0000-4000-8000-000000000002" as WindowId;
const secondHubWindowId = "00000000-0000-4000-8000-000000000003" as WindowId;
const hubBounds = { x: 0, y: 0, width: 1200, height: 800 };
const hubWindow = {
  windowId: hubWindowId,
  identity: HUB_WINDOW_IDENTITY,
  route: "/settings/general",
  bounds: hubBounds,
};
const projectWindow = {
  windowId: projectWindowId,
  identity: projectIdentity,
  route: "/project/environment-1/project-1",
  bounds: null,
};
const secondHubWindow = { ...hubWindow, windowId: secondHubWindowId, route: "/" };

const v2 = (windows: readonly unknown[], reason = "update") => ({
  version: 2,
  reason,
  capturedAtMs: 1_000,
  windows,
});

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
    snapshotAddresses: Effect.succeed(new Set<string>()),
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
  it.effect("round-trips every open window with its route, bounds, and workspace", () =>
    withSession(
      Effect.gen(function* () {
        const session = yield* DesktopWindowSession.DesktopWindowSession;
        yield* session.capture([hubWindow, projectWindow, secondHubWindow], "update");

        // Each window comes back under the id it had, so the relaunch keeps it,
        // and a second all-projects window is its own entry, not a duplicate.
        assert.deepEqual(yield* session.consume, [
          {
            windowId: hubWindowId,
            route: "/settings/general",
            seed: "all-projects",
            bounds: hubBounds,
            workspace: { id: 1, name: "1" },
          },
          {
            windowId: projectWindowId,
            route: "/project/environment-1/project-1",
            seed: projectSeed,
            bounds: null,
            workspace: { id: 4, name: "code" },
          },
          {
            windowId: secondHubWindowId,
            route: "/",
            seed: "all-projects",
            bounds: hubBounds,
            workspace: null,
          },
        ]);
      }),
      {
        [hubWindowId]: { id: 1, name: "1" },
        [projectWindowId]: { id: 4, name: "code" },
      },
    ),
  );

  it.effect("consumes once, so a normal relaunch never resurrects windows", () =>
    withSession(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const session = yield* DesktopWindowSession.DesktopWindowSession;
        yield* session.capture([projectWindow], "update");

        assert.lengthOf(yield* session.consume, 1);
        assert.isFalse(yield* fileSystem.exists(environment.windowSessionPath));
        assert.deepEqual(yield* session.consume, []);
      }),
    ),
  );

  it.effect("restores only a manifest an update relaunch wrote", () =>
    withSession(
      Effect.gen(function* () {
        const session = yield* DesktopWindowSession.DesktopWindowSession;
        yield* session.capture([projectWindow], "quit");

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
    const document = v2([{ windowId: hubWindowId, route: "/", workspace: null }]);
    assert.lengthOf(DesktopWindowSession.readRestoreEntries(document, 2_000), 1);
    assert.lengthOf(
      DesktopWindowSession.readRestoreEntries(
        document,
        1_000 + DesktopWindowSession.WINDOW_SESSION_MAX_AGE_MS + 1,
      ),
      0,
    );
  });

  it("opens a window whose route is not restorable at its home", () => {
    const routes = ["https://evil.example/", "//evil.example", "project/x", "/a b", "/a\u0007"];
    assert.deepEqual(
      DesktopWindowSession.readRestoreEntries(
        v2(
          routes.map((route, index) => ({
            windowId: `00000000-0000-4000-8000-00000000001${index}`,
            route,
          })),
        ),
        1_500,
      ).map((entry) => entry.route),
      ["/", "/", "/", "/", "/"],
    );
  });

  it("keeps only bounds that describe a window", () => {
    assert.deepEqual(
      DesktopWindowSession.readRestoreEntries(
        v2([
          { windowId: hubWindowId, route: "/", bounds: hubBounds },
          { windowId: secondHubWindowId, route: "/", bounds: { x: 0, y: 0, width: -5 } },
        ]),
        1_500,
      ).map((entry) => entry.bounds),
      [hubBounds, null],
    );
  });

  it("drops a row without a window id or project and keeps the rest", () => {
    assert.deepEqual(
      DesktopWindowSession.readRestoreEntries(
        v2([
          { windowId: "project:environment-1:project-1", route: "/" },
          { windowId: projectWindowId, route: "/", project: { environmentId: "", projectId: "p" } },
          { windowId: hubWindowId, route: "/", workspace: null },
          { windowId: hubWindowId, route: "/settings", workspace: null },
          "not a row",
        ]),
        1_500,
      ),
      [{ windowId: hubWindowId, route: "/", seed: "all-projects", bounds: null, workspace: null }],
    );
  });

  it("reads a v1 manifest: a project row seeds its window, a hub row opens all projects", () => {
    assert.deepEqual(
      DesktopWindowSession.readRestoreEntries(
        {
          version: 1,
          reason: "update",
          capturedAtMs: 1_000,
          windows: [
            { windowId: hubWindowId, kind: "hub", workspace: { id: 1, name: "1" } },
            { kind: "hub", workspace: null },
            {
              windowId: "project:environment-1:project-1",
              kind: "project",
              environmentId: "environment-1",
              projectId: "project-1",
              workspace: null,
            },
            { kind: "project", environmentId: "", projectId: "project-1", workspace: null },
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
      [
        {
          windowId: hubWindowId,
          route: "/",
          seed: "all-projects",
          bounds: null,
          workspace: { id: 1, name: "1" },
        },
        { route: "/", seed: "all-projects", bounds: null, workspace: null },
        { route: "/", seed: projectSeed, bounds: null, workspace: null },
      ],
    );
  });
});
