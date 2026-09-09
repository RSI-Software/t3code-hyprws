import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import { projectWindowIdentity } from "../../window/WindowIdentity.ts";
import { listPendingSnapShots } from "./snapShot.ts";

const { fromWebContents, fromId } = vi.hoisted(() => ({
  fromWebContents: vi.fn(() => null as Electron.BrowserWindow | null),
  fromId: vi.fn(() => null as Electron.WebContents | null),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents },
  webContents: { fromId },
}));

const HUB_WEB_CONTENTS_ID = 7;
const PROJECT_WEB_CONTENTS_ID = 11;

const hubWindow = { webContents: { id: HUB_WEB_CONTENTS_ID } } as Electron.BrowserWindow;
const projectWindow = { webContents: { id: PROJECT_WEB_CONTENTS_ID } } as Electron.BrowserWindow;

const projectIdentity = projectWindowIdentity(
  EnvironmentId.make("env-1"),
  ProjectId.make("project-1"),
);

/** Registers `projectWindow` only, so an unregistered sender resolves to None. */
const windowLayer = (registered: Electron.BrowserWindow | null) =>
  Layer.succeed(
    ElectronWindow.ElectronWindow,
    ElectronWindow.ElectronWindow.of({
      main: Effect.succeed(Option.some(hubWindow)),
      identityFor: (window: Electron.BrowserWindow) =>
        Effect.succeed(window === registered ? Option.some(projectIdentity) : Option.none()),
    } as ElectronWindow.ElectronWindow["Service"]),
  );

const pendingLayer = (pending: readonly unknown[]) =>
  Layer.succeed(
    DesktopSnapShot.DesktopSnapShot,
    DesktopSnapShot.DesktopSnapShot.of({
      listPending: Effect.succeed(pending),
    } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
  );

describe("window capture IPC, fork project windows", () => {
  it.effect("serves a registered project window that is not the hub", () => {
    fromId.mockReturnValue({ id: PROJECT_WEB_CONTENTS_ID } as Electron.WebContents);
    fromWebContents.mockReturnValue(projectWindow);

    return Effect.gen(function* () {
      const pending = yield* listPendingSnapShots.handler(undefined, {
        sender: { id: PROJECT_WEB_CONTENTS_ID },
      });
      assert.deepEqual(pending, []);
    }).pipe(Effect.provide(Layer.mergeAll(windowLayer(projectWindow), pendingLayer([]))));
  });

  it.effect("still rejects a window the registry does not carry", () => {
    fromId.mockReturnValue({ id: 99 } as Electron.WebContents);
    fromWebContents.mockReturnValue({ webContents: { id: 99 } } as Electron.BrowserWindow);

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        listPendingSnapShots.handler(undefined, { sender: { id: 99 } }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      assert.equal(
        (failure.value as { readonly _tag: string })._tag,
        "SnapShotIpcUnauthorizedSenderError",
      );
    }).pipe(Effect.provide(Layer.mergeAll(windowLayer(projectWindow), pendingLayer([]))));
  });
});
