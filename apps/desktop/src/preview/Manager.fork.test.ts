import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { describe, expect, vi } from "vite-plus/test";
import type { WindowId } from "../window/WindowId.fork.ts";
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
        const firstWindowId = "00000000-0000-4000-8000-000000000001" as WindowId;
        const secondWindowId = "00000000-0000-4000-8000-000000000002" as WindowId;
        const first = yield* manager.forWindow(firstWindowId);
        const second = yield* manager.forWindow(secondWindowId);
        const deliveries: string[] = [];
        yield* manager.subscribeOwnedStateChanges((owner, tabId) =>
          Effect.sync(() => {
            deliveries.push(`${owner}:${tabId}`);
          }),
        );

        const firstState = yield* first.createTab("shared-tab", { zoomFactor: 1.25 });
        const secondState = yield* second.createTab("shared-tab", { zoomFactor: 0.8 });

        expect(firstState.zoomFactor).toBe(1.25);
        expect(secondState.zoomFactor).toBe(0.8);
        expect(deliveries).toEqual([`${firstWindowId}:shared-tab`, `${secondWindowId}:shared-tab`]);
      }),
    ),
  );

  effectIt.effect("explicitly rejects a tab owned only by another window", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const owner = yield* manager.forWindow("00000000-0000-4000-8000-00000000000a" as WindowId);
        const other = yield* manager.forWindow("00000000-0000-4000-8000-00000000000b" as WindowId);
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
