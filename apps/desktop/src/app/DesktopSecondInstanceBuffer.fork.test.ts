import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type * as ElectronApp from "../electron/ElectronApp.ts";
import {
  makeStartupDrain,
  STARTUP_INTENT_QUEUE_CAPACITY,
  type StartupDrainServices,
  type WindowOpeners,
} from "../window/DesktopStartupDrain.fork.ts";
import { projectWindowIdentity, type WindowIdentity } from "../window/WindowIdentity.ts";
import { makeSecondInstanceBuffer } from "./DesktopSecondInstanceBuffer.fork.ts";

const fakeWindow = {} as Electron.BrowserWindow;

const noopServices: StartupDrainServices = {
  hyprlandPlacement: {
    isAvailable: false,
    claim: () => Effect.void,
    forget: () => Effect.void,
    workspaceOf: () => Effect.succeedNone,
    stageWorkspaceRule: () => Effect.succeed(false),
    clearWorkspaceRule: () => Effect.void,
    moveToWorkspace: () => Effect.void,
  },
  windowSession: { capture: () => Effect.void, consume: Effect.succeed([]) },
};

const makeFakeApp = () => {
  const listeners: Array<(...args: ReadonlyArray<unknown>) => void> = [];
  const electronApp = {
    on: (eventName: string, listener: (...args: ReadonlyArray<unknown>) => void) =>
      Effect.sync(() => {
        if (eventName === "second-instance") listeners.push(listener);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];
  const emit = (argv: readonly string[]) => {
    for (const listener of listeners) listener({}, argv);
  };
  return { electronApp, emit } as const;
};

// argv is ["t3code", <name>]; the resolver maps the name to a project window.
const identityOf = (argv: readonly string[]): WindowIdentity | null =>
  argv[1] === undefined
    ? null
    : projectWindowIdentity(
        EnvironmentId.make(`environment-${argv[1]}`),
        ProjectId.make(`project-${argv[1]}`),
      );

describe("DesktopSecondInstanceBuffer", () => {
  it.effect("opens a launch emitted before configure after the first intent, once", () =>
    Effect.gen(function* () {
      const drain = yield* makeStartupDrain;
      const buffer = makeSecondInstanceBuffer();
      const app = makeFakeApp();
      const opened = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (identity: WindowIdentity) =>
        Ref.update(opened, (keys) => [
          ...keys,
          identity.kind === "hub" ? "hub" : identity.ref.projectId,
        ]).pipe(Effect.as(fakeWindow));
      const openers: WindowOpeners = {
        ensureIdentity: () => record,
        revealOrCreateIdentity: () => record,
        createMainIfBackendReady: () => Effect.void,
      };
      const stage = (argv: readonly string[]) =>
        drain.stageArguments(noopServices, identityOf, argv).pipe(Effect.asVoid);

      yield* buffer.listen(app.electronApp);
      // Emitted in the gap before configure registers the real listener.
      app.emit(["t3code", "second"]);
      yield* buffer.close;
      // After close the real listener owns the event; the buffer must not
      // replay it too.
      app.emit(["t3code", "late"]);
      yield* stage(["t3code", "first"]);
      yield* buffer.flush(stage);
      yield* buffer.flush(stage);
      yield* drain.drain(noopServices, () => openers);
      assert.deepEqual(yield* Ref.get(opened), ["project-first", "project-second"]);
    }),
  );

  it.effect("holds at most the startup queue capacity", () =>
    Effect.gen(function* () {
      const buffer = makeSecondInstanceBuffer();
      const app = makeFakeApp();
      yield* buffer.listen(app.electronApp);
      for (let index = 0; index < STARTUP_INTENT_QUEUE_CAPACITY + 3; index += 1) {
        app.emit(["t3code", `launch-${index}`]);
      }
      const replayed: Array<string> = [];
      yield* buffer.flush((argv) => Effect.sync(() => void replayed.push(argv[1] ?? "")));
      assert.equal(replayed.length, STARTUP_INTENT_QUEUE_CAPACITY);
      assert.equal(replayed[0], "launch-0");
    }),
  );
});
