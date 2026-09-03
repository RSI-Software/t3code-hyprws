import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { HUB_WINDOW_IDENTITY, projectWindowIdentity } from "../window/WindowIdentity.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";
describe("DesktopUpdates", () => {
  it.effect("records the open windows before the install tears them down", () => {
    const projectIdentity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );
    const harness = makeHarness({
      openWindowIdentities: [HUB_WINDOW_IDENTITY, projectIdentity],
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.deepEqual(harness.capturedSessions, [
          { identities: [HUB_WINDOW_IDENTITY, projectIdentity], reason: "update" },
        ]);
        // The windows have to still exist when their workspaces are read.
        assert.deepEqual(harness.installSteps, ["capture", "quitAndInstall"]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
