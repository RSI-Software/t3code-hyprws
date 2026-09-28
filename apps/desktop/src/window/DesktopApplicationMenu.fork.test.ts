import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as Electron from "electron";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import type { WindowRequest } from "./WindowDispatch.fork.ts";

const configureMenu = (
  platform: DesktopEnvironment.MakeDesktopEnvironmentInput["platform"],
  requested: Deferred.Deferred<WindowRequest>,
) =>
  Effect.gen(function* () {
    const template = yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
    yield* Effect.gen(function* () {
      yield* (yield* DesktopApplicationMenu.DesktopApplicationMenu).configure;
    }).pipe(
      Effect.provide(
        DesktopApplicationMenu.layer.pipe(
          Layer.provideMerge(
            Layer.mock(ElectronMenu.ElectronMenu)({
              setApplicationMenu: (items) => Deferred.succeed(template, items).pipe(Effect.asVoid),
            }),
          ),
          Layer.provideMerge(
            Layer.mock(DesktopWindow.DesktopWindow)({
              requestWindow: (request) => Deferred.succeed(requested, request).pipe(Effect.asVoid),
            }),
          ),
          Layer.provideMerge(Layer.mock(DesktopUpdates.DesktopUpdates)({})),
          Layer.provideMerge(Layer.mock(ElectronDialog.ElectronDialog)({})),
          Layer.provideMerge(
            Layer.mock(ElectronApp.ElectronApp)({ name: Effect.succeed("T3 Code") }),
          ),
          Layer.provideMerge(
            DesktopEnvironment.layer({
              dirname: "/repo/apps/desktop/dist-electron",
              homeDirectory: "/home/alice",
              platform,
              processArch: "x64",
              appVersion: "1.2.3",
              appPath: "/repo",
              isPackaged: false,
              resourcesPath: "/repo/resources",
              runningUnderArm64Translation: false,
            }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({})))),
          ),
        ),
      ),
    );
    return yield* Deferred.await(template);
  });

describe("DesktopApplicationMenu (fork)", () => {
  it.effect.each(["linux", "darwin"] as const)(
    "File > New Window requests a new window through the dispatch on %s",
    (platform) =>
      Effect.gen(function* () {
        const requested = yield* Deferred.make<WindowRequest>();
        const template = yield* configureMenu(platform, requested);
        const fileMenu = template.find((item) => item.label === "File");
        if (fileMenu === undefined || !Array.isArray(fileMenu.submenu)) {
          throw new Error("Expected a File menu with a submenu array.");
        }
        const newWindow = fileMenu.submenu.find((item) => item.label === "New Window");
        assert.isDefined(newWindow);
        // The renderer keybinding owns the chord; an accelerator would fire twice.
        assert.isUndefined(newWindow.accelerator);
        const click = newWindow.click;
        if (typeof click !== "function") throw new Error("Expected a click handler.");
        click({} as Electron.MenuItem, undefined, {} as KeyboardEvent);
        assert.deepEqual(yield* Deferred.await(requested), { kind: "new-window" });
      }),
  );
});
