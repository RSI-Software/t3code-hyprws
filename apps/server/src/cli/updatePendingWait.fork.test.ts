import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import type { BootServiceStatus } from "../cloud/bootService.ts";
import { SERVICE_LAUNCHER_PROTOCOL, SERVICE_STATE_FILE } from "../cloud/serviceProtocol.ts";
import { awaitPendingServiceUpdate } from "./updatePendingWait.fork.ts";

const pendingState = JSON.stringify({
  protocol: SERVICE_LAUNCHER_PROTOCOL,
  activeVersion: "1.2.3",
  update: { id: "u", fromVersion: "1.2.3", targetVersion: "1.2.4", status: "pending" },
});
const committedState = JSON.stringify({
  protocol: SERVICE_LAUNCHER_PROTOCOL,
  activeVersion: "1.2.4",
  update: { id: "u", fromVersion: "1.2.3", targetVersion: "1.2.4", status: "committed" },
});

const makeHome = Effect.fn("test.make_pending_wait_home")(function* (state: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-wait-" });
  const statePath = path.join(baseDir, "runtime", SERVICE_STATE_FILE);
  yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
  yield* fs.writeFileString(statePath, state);
  return { fs, baseDir, statePath };
});

const statusWith = (problems: NonNullable<BootServiceStatus["problems"]>) =>
  Effect.succeed({
    supported: true,
    installed: true,
    current: false,
    problems,
    unitPath: "",
    logPath: "",
  } satisfies BootServiceStatus);

it.layer(NodeServices.layer)("awaitPendingServiceUpdate", (it) => {
  it.effect("waits for a running launcher to finish its update", () =>
    Effect.gen(function* () {
      const { fs, baseDir, statePath } = yield* makeHome(pendingState);
      const fiber = yield* awaitPendingServiceUpdate({ baseDir, status: statusWith([]) }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* fs.writeFileString(statePath, committedState);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
    }),
  );

  it.effect("does not wait on a pending update left by a stopped service", () =>
    Effect.gen(function* () {
      const { baseDir } = yield* makeHome(pendingState);
      yield* awaitPendingServiceUpdate({ baseDir, status: statusWith(["service-stopped"]) });
    }),
  );
});
