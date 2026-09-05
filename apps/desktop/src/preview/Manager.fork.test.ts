import { it as effectIt } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { describe, expect, vi } from "vite-plus/test";
import { projectWindowIdentity, windowIdentityKey } from "../window/WindowIdentity.ts";
import { previewManagerFixtureLayer } from "./Manager.fork-test-harness.ts";
import * as PreviewManager from "./Manager.ts";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  clipboard: { writeImage: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getFocusedWebContents: vi.fn(() => null) },
}));

const layer = previewManagerFixtureLayer();
const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) => Effect.flatMap(PreviewManager.PreviewManager, use).pipe(Effect.provide(layer), Effect.scoped);

describe("fork preview manager ownership", () => {
  effectIt.effect("namespaces equal tab ids by owning window and routes events to that owner", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstIdentity = projectWindowIdentity(
          EnvironmentId.make("environment-1"),
          ProjectId.make("project-1"),
        );
        const secondIdentity = projectWindowIdentity(
          EnvironmentId.make("environment-1"),
          ProjectId.make("project-2"),
        );
        const first = yield* manager.forWindow(firstIdentity);
        const second = yield* manager.forWindow(secondIdentity);
        const deliveries: string[] = [];
        yield* manager.subscribeOwnedStateChanges((identity, tabId) =>
          Effect.sync(() => {
            deliveries.push(`${windowIdentityKey(identity)}:${tabId}`);
          }),
        );

        const firstState = yield* first.createTab("shared-tab", { zoomFactor: 1.25 });
        const secondState = yield* second.createTab("shared-tab", { zoomFactor: 0.8 });

        expect(firstState.zoomFactor).toBe(1.25);
        expect(secondState.zoomFactor).toBe(0.8);
        expect(deliveries).toEqual([
          `${windowIdentityKey(firstIdentity)}:shared-tab`,
          `${windowIdentityKey(secondIdentity)}:shared-tab`,
        ]);
      }),
    ),
  );

  effectIt.effect("explicitly rejects a tab owned only by another window", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const owner = yield* manager.forWindow(
          projectWindowIdentity(
            EnvironmentId.make("environment-1"),
            ProjectId.make("project-owner"),
          ),
        );
        const other = yield* manager.forWindow(
          projectWindowIdentity(
            EnvironmentId.make("environment-1"),
            ProjectId.make("project-other"),
          ),
        );
        yield* owner.createTab("owned-tab");

        const exit = yield* Effect.exit(other.closeTab("owned-tab"));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewTabOwnershipError",
            tabId: "owned-tab",
          });
        }
      }),
    ),
  );
});
