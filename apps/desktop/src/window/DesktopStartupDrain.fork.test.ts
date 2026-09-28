// Fork-owned sibling for DesktopStartupDrain.fork.ts: the drain's own tests
// live here, never appended to the upstream DesktopWindow.test.ts harness.
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  HUB_WINDOW_IDENTITY,
  projectWindowIdentity,
  type WindowIdentity,
} from "./WindowIdentity.ts";
import {
  makeStartupDrain,
  type StartupDrainServices,
  type WindowOpeners,
} from "./DesktopStartupDrain.fork.ts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { WindowId } from "./WindowId.fork.ts";

const fakeWindow = {} as Electron.BrowserWindow;
const fakeWindowId = "00000000-0000-4000-8000-000000000001" as WindowId;

/** Adapts a window opener to the restore opener, which also reports the id. */
const asEnsure =
  (open: () => (identity: WindowIdentity) => Effect.Effect<Electron.BrowserWindow>) =>
  () =>
  (identity: WindowIdentity) =>
    open()(identity).pipe(Effect.map((window) => ({ window, windowId: fakeWindowId })));

const projectIdentity = (name: string): WindowIdentity =>
  projectWindowIdentity(
    EnvironmentId.make(`environment-${name}`),
    ProjectId.make(`project-${name}`),
  );

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
  windowSession: {
    capture: () => Effect.void,
    consume: Effect.succeed([]),
  },
};

interface FakeOpeners {
  readonly openers: WindowOpeners;
  readonly opened: Ref.Ref<ReadonlyArray<string>>;
  readonly keyOf: (identity: WindowIdentity) => string;
  /** Release gate each open awaits: the test pauses the drain mid-open. */
  readonly gate: Deferred.Deferred<void>;
  /** Set when an open is parked inside the gate. */
  readonly entered: Deferred.Deferred<void>;
}

/**
 * Openers that record every open by identity key; create/ensure/reveal all
 * succeed. Every open parks on `gate` after recording, so the test can
 * pause the drain mid-open and stage arrivals before releasing.
 */
const makeRecordingOpeners = Effect.gen(function* () {
  const opened = yield* Ref.make<ReadonlyArray<string>>([]);
  const gate = yield* Deferred.make<void>();
  const entered = yield* Deferred.make<void>();
  const keyOf = (identity: WindowIdentity): string =>
    identity.kind === "hub" ? "hub" : `project:${identity.ref.projectId}`;
  const record = (identity: WindowIdentity) =>
    Ref.update(opened, (keys) => [...keys, keyOf(identity)]).pipe(
      Effect.andThen(Deferred.succeed(entered, undefined)),
      Effect.andThen(Deferred.await(gate)),
      Effect.as(fakeWindow),
    );
  yield* Deferred.succeed(gate, undefined);
  const openers: WindowOpeners = {
    ensureIdentity: asEnsure(() => record),
    revealOrCreateIdentity: () => record,
    createMainIfBackendReady: () =>
      Ref.update(opened, (keys) => [...keys, "hub"]).pipe(Effect.asVoid),
  };
  return { openers, opened, keyOf, gate, entered } as const;
});

describe("DesktopStartupDrain", () => {
  it.effect("opens the restore before an intent queued during it", () =>
    Effect.gen(function* () {
      const drain = yield* makeStartupDrain;
      // Fresh gate: this test pauses the drain inside the restore open
      // itself (the shared helper's gate starts released).
      const restoreEntered = yield* Deferred.make<void>();
      const releaseRestore = yield* Deferred.make<void>();
      const opened = yield* Ref.make<ReadonlyArray<string>>([]);
      let restoreCalls = 0;
      const pausingEnsure = () => (identity: WindowIdentity) =>
        Effect.gen(function* () {
          restoreCalls += 1;
          yield* Ref.update(opened, (keys) => [...keys, "restore"]);
          yield* Deferred.succeed(restoreEntered, undefined);
          yield* Deferred.await(releaseRestore);
          return fakeWindow;
        });
      const keyOf = (identity: WindowIdentity): string =>
        identity.kind === "hub" ? "hub" : `project:${identity.ref.projectId}`;
      const openers: WindowOpeners = {
        ensureIdentity: asEnsure(pausingEnsure),
        revealOrCreateIdentity: () => (identity: WindowIdentity) =>
          Ref.update(opened, (keys) => [...keys, keyOf(identity)]).pipe(Effect.as(fakeWindow)),
        createMainIfBackendReady: () => Effect.void,
      };
      const identityOf = () => projectIdentity("straggler");
      yield* drain.stageRestore({
        ...noopServices,
        windowSession: {
          capture: () => Effect.void,
          consume: Effect.succeed([{ identity: HUB_WINDOW_IDENTITY, workspace: null }]),
        },
      });
      const drainFiber = yield* drain.drain(noopServices, () => openers).pipe(Effect.forkDetach);
      // Park inside the paused restore open: readiness stays false until the
      // drain finishes, so the intent below stages through the queue.
      yield* Deferred.await(restoreEntered);
      const staged = yield* drain.stageArguments(noopServices, identityOf, ["t3code"]);
      assert.deepEqual(staged, { queued: true });
      yield* Deferred.succeed(releaseRestore, undefined);
      yield* Fiber.join(drainFiber);
      assert.equal(restoreCalls, 1);
      assert.deepEqual(yield* Ref.get(opened), ["restore", "project:project-straggler"]);
    }),
  );

  it.effect("opens a straggler queued while a queued-intent open is paused", () =>
    Effect.gen(function* () {
      const drain = yield* makeStartupDrain;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const opened = yield* Ref.make<ReadonlyArray<string>>([]);
      const keyOf = (identity: WindowIdentity): string =>
        identity.kind === "hub" ? "hub" : `project:${identity.ref.projectId}`;
      const pausingReveal = () => (identity: WindowIdentity) =>
        Effect.gen(function* () {
          const key = keyOf(identity);
          yield* Ref.update(opened, (keys) => [...keys, key]);
          if (key === "project:project-first") {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return fakeWindow;
        });
      const openers: WindowOpeners = {
        ensureIdentity: asEnsure(pausingReveal),
        revealOrCreateIdentity: pausingReveal,
        createMainIfBackendReady: () => Effect.void,
      };
      yield* drain.queueStartupIntent(projectIdentity("first"));
      const drainFiber = yield* drain.drain(noopServices, () => openers).pipe(Effect.forkDetach);
      // Paused after the first queue poll, inside the queued intent's open.
      yield* Deferred.await(entered);
      const staged = yield* drain.stageArguments(noopServices, () => projectIdentity("straggler"), [
        "t3code",
      ]);
      assert.deepEqual(staged, { queued: true });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(drainFiber);
      assert.deepEqual(yield* Ref.get(opened), [
        "project:project-first",
        "project:project-straggler",
      ]);
    }),
  );

  it.effect("completes followers admitted while the owner is suspended in an open", () =>
    Effect.gen(function* () {
      const drain = yield* makeStartupDrain;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const opened = yield* Ref.make<ReadonlyArray<string>>([]);
      const pausingReveal = () => (identity: WindowIdentity) =>
        Effect.gen(function* () {
          yield* Ref.update(opened, (keys) => [
            ...keys,
            identity.kind === "hub" ? "hub" : `project:${identity.ref.projectId}`,
          ]);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return fakeWindow;
        });
      const openers: WindowOpeners = {
        ensureIdentity: asEnsure(pausingReveal),
        revealOrCreateIdentity: pausingReveal,
        createMainIfBackendReady: () => Effect.void,
      };
      yield* drain.queueStartupIntent(projectIdentity("one"));
      const owner = yield* drain.drain(noopServices, () => openers).pipe(Effect.forkDetach);
      yield* Deferred.await(entered);
      const firstFollower = yield* drain.drain(noopServices, () => openers).pipe(Effect.forkDetach);
      const secondFollower = yield* drain
        .drain(noopServices, () => openers)
        .pipe(Effect.forkDetach);
      // Let both followers reach their claim before the owner resumes.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
      yield* Fiber.join(firstFollower);
      yield* Fiber.join(secondFollower);
      assert.deepEqual(yield* Ref.get(opened), ["project:project-one"]);
    }),
  );

  it.effect("fails typed on a bad open and still opens the rest", () =>
    Effect.gen(function* () {
      const drain = yield* makeStartupDrain;
      const fakes = yield* makeRecordingOpeners;
      const failing: WindowOpeners = {
        ...fakes.openers,
        revealOrCreateIdentity: () => (identity: WindowIdentity) =>
          fakes.keyOf(identity) === "project:project-bad"
            ? Effect.fail(
                new ElectronWindow.ElectronWindowCreateError({
                  options: {
                    title: null,
                    width: null,
                    height: null,
                    minWidth: null,
                    minHeight: null,
                    show: null,
                    modal: null,
                    frame: null,
                    transparent: null,
                    backgroundColor: null,
                    webPreferences: {
                      preload: null,
                      partition: null,
                      backgroundThrottling: null,
                      sandbox: null,
                      contextIsolation: null,
                      nodeIntegration: null,
                      webviewTag: null,
                    },
                  },
                  cause: new Error("simulated window-open failure"),
                }),
              )
            : Ref.update(fakes.opened, (keys) => [...keys, fakes.keyOf(identity)]).pipe(
                Effect.as(fakeWindow),
              ),
      };
      yield* drain.queueStartupIntent(projectIdentity("bad"));
      yield* drain.queueStartupIntent(projectIdentity("second"));
      yield* drain.queueStartupIntent(projectIdentity("third"));
      const exit = yield* Effect.exit(drain.drain(noopServices, () => failing));
      // Typed Fail, never a Die defect: the backend pool logs-and-swallows
      // typed failures from handleBackendReady, but a defect would bypass
      // that DesktopWindowError contract — so assert every reason is Fail.
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(exit.cause.reasons.every((reason) => Cause.isFailReason(reason)));
        assert.isTrue(
          exit.cause.reasons.some(
            (reason) =>
              Cause.isFailReason(reason) &&
              Schema.is(ElectronWindow.ElectronWindowCreateError)(reason.error),
          ),
        );
      }
      assert.deepEqual(yield* Ref.get(fakes.opened), [
        "project:project-second",
        "project:project-third",
      ]);
    }),
  );

  it.effect("re-arms after a restart: new intents queue and drain", () =>
    Effect.gen(function* () {
      const drain = yield* makeStartupDrain;
      const fakes = yield* makeRecordingOpeners;
      yield* drain.queueStartupIntent(projectIdentity("first"));
      yield* drain.drain(noopServices, () => fakes.openers);
      assert.deepEqual(yield* Ref.get(fakes.opened), ["project:project-first"]);
      // A backend restart clears readiness; an intent arriving while down
      // queues, and the next ready transition drains it. Without the
      // markNotReady re-arm the second drain would read ready and stage
      // the intent for direct dispatch — bypassing the queue — so assert
      // the staged result queues and the drain opens it.
      yield* drain.markNotReady;
      const staged = yield* drain.stageArguments(noopServices, () => projectIdentity("second"), [
        "t3code",
      ]);
      assert.deepEqual(staged, { queued: true });
      yield* drain.drain(noopServices, () => fakes.openers);
      assert.deepEqual(yield* Ref.get(fakes.opened), [
        "project:project-first",
        "project:project-second",
      ]);
    }),
  );
});
