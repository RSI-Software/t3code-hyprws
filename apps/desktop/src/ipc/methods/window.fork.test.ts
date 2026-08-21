import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { openProjectWindow } from "./window.ts";
describe("openProjectWindow", () => {
  it.effect("validates scoped refs and delegates repeated opens to the window registry", () => {
    const openedIdentities: Parameters<
      DesktopWindow.DesktopWindow["Service"]["openIdentity"]
    >[0][] = [];
    const window = {} as Electron.BrowserWindow;
    const layer = Layer.mock(DesktopWindow.DesktopWindow)({
      openIdentity: (identity) =>
        Effect.sync(() => {
          openedIdentities.push(identity);
          return window;
        }),
    });
    const projectRef = {
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
    };
    return Effect.gen(function* () {
      yield* openProjectWindow.handler(projectRef);
      yield* openProjectWindow.handler(projectRef);
      assert.deepEqual(openedIdentities, [
        { kind: "project", ref: projectRef },
        { kind: "project", ref: projectRef },
      ]);
      const malformed = yield* Effect.result(
        openProjectWindow.handler({ environmentId: " ", projectId: "project-1" }),
      );
      assert.isTrue(malformed._tag === "Failure");
      assert.lengthOf(openedIdentities, 2);
    }).pipe(Effect.provide(layer));
  });
});
