import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { WindowId } from "../window/WindowId.fork.ts";
import { HUB_WINDOW_IDENTITY, projectWindowIdentity } from "../window/WindowIdentity.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { FORK_NIGHTLY_UPDATE_CHANNEL, resolveForkUpdaterChannel } from "./updateChannels.fork.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it.effect("records the open windows before the install tears them down", () => {
    const projectIdentity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );
    const openWindows = [
      {
        windowId: "00000000-0000-4000-8000-000000000001" as WindowId,
        identity: HUB_WINDOW_IDENTITY,
        route: "/",
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
      },
      {
        windowId: "00000000-0000-4000-8000-000000000002" as WindowId,
        identity: projectIdentity,
        route: "/project/environment-1/project-1",
        bounds: null,
      },
    ];
    const harness = makeHarness({ openWindows });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.deepEqual(harness.capturedSessions, [{ windows: openWindows, reason: "update" }]);
        // The windows have to still exist when their workspaces are read.
        assert.deepEqual(harness.installSteps, ["quitAndInstall"]);
        assert.deepEqual(harness.installStepsBeforeCapture, [0]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});

describe("DesktopUpdates fork update channels", () => {
  it("maps the nightly user channel to the fork tag identifier for the updater", () => {
    assert.equal(resolveForkUpdaterChannel("nightly"), FORK_NIGHTLY_UPDATE_CHANNEL);
    assert.equal(resolveForkUpdaterChannel("latest"), "latest");
  });

  it.effect("sends hyprws-nightly to the updater while the user stays on nightly", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.deepEqual(harness.channels(), ["latest"]);

        yield* updates.setChannel("nightly");
        assert.deepEqual(harness.channels(), ["latest", FORK_NIGHTLY_UPDATE_CHANNEL]);

        yield* updates.setChannel("latest");
        assert.deepEqual(harness.channels(), ["latest", FORK_NIGHTLY_UPDATE_CHANNEL, "latest"]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("offers a fork nightly to a user on the nightly channel", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("nightly");

        harness.emit("update-available", { version: "0.0.43-hyprws-nightly.20260928.776" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "0.0.43-hyprws-nightly.20260928.776");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
