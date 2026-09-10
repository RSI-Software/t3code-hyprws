import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
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
});
