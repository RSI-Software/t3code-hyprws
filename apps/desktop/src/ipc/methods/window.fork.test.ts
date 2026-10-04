import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { HyprlandPlacement } from "../../window/HyprlandPlacement.ts";
import { publishWindowProjects } from "./window.fork.ts";

describe("publishWindowProjects", () => {
  const windowId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const scope = { kind: "all" } as const;
  const window = { webContents: { id: 7 } } as unknown as Electron.BrowserWindow;

  // Runs one report with the given sender, and returns what reached placement.
  const report = (payload: unknown, sender: { readonly id: number } | undefined) => {
    const published: Array<{ readonly windowId: string; readonly scope: unknown }> = [];
    return publishWindowProjects.handler(payload, sender && { sender }).pipe(
      Effect.as(published),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ElectronWindow.ElectronWindow)({
            getById: (id) => Effect.succeed(id === windowId ? Option.some(window) : Option.none()),
          }),
          Layer.mock(HyprlandPlacement)({
            isAvailable: true,
            publishScope: (id, reported) =>
              Effect.sync(() => void published.push({ windowId: id, scope: reported })),
          }),
        ),
      ),
    );
  };

  it.effect("records the scope a window reports for itself", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* report({ windowId, scope }, { id: 7 }), [{ windowId, scope }]);
    }),
  );

  it.effect("ignores a report from another window's sender, or none", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* report({ windowId, scope }, { id: 8 }), []);
      assert.deepEqual(yield* report({ windowId, scope }, undefined), []);
    }),
  );

  it.effect("ignores a report for an unknown or malformed window id", () =>
    Effect.gen(function* () {
      const unknown = "1f8fad5b-d9cb-469f-a165-70867728950e";
      assert.deepEqual(yield* report({ windowId: unknown, scope }, { id: 7 }), []);
      assert.deepEqual(yield* report({ windowId: "hub", scope }, { id: 7 }), []);
    }),
  );
});
