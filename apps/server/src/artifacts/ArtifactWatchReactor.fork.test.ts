import {
  EventId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShellSnapshot,
  type ThreadArtifactLink,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ServerActivation } from "../serverActivation.ts";
import {
  ArtifactDirectoryWatch,
  type ArtifactDirectoryWatcher,
} from "./ArtifactDirectoryWatch.fork.ts";
import * as ArtifactWatchReactor from "./ArtifactWatchReactor.fork.ts";

const EARLIER = "2026-10-29T10:00:00.000Z";
const T0 = "2026-10-30T10:00:00.000Z";
const T1 = "2026-10-30T10:05:00.000Z";
const T2 = "2026-10-30T10:10:00.000Z";

type ObserveCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.artifact.observe" }
>;

interface FakeThread {
  readonly id: ThreadId;
  readonly archivedAt: DateTime.Utc | null;
  readonly deletedAt: DateTime.Utc | null;
  readonly artifacts: ReadonlyArray<ThreadArtifactLink>;
}

interface FakeWatch {
  readonly directory: string;
  closed: boolean;
  readonly emit: (name: string) => void;
  readonly fail: () => void;
}

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const link = (path: string, fields: Partial<ThreadArtifactLink> = {}): ThreadArtifactLink => ({
  path,
  title: "Tracker",
  source: "agent",
  linkedAt: T0,
  updatedAt: T0,
  missing: false,
  ...fields,
});

const thread = (
  id: string,
  artifacts: ReadonlyArray<ThreadArtifactLink>,
  state: "active" | "archived" | "deleted" = "active",
): FakeThread => ({
  id: ThreadId.make(id),
  archivedAt: state === "archived" ? DateTime.makeUnsafe(T1) : null,
  deletedAt: state === "deleted" ? DateTime.makeUnsafe(T1) : null,
  artifacts,
});

// The reactor reads only a thread's lifecycle and links, so the rest of the payload is left out.
const threadEvent = (type: OrchestrationV2DomainEvent["type"], payload: FakeThread) =>
  ({
    type,
    id: EventId.make(`${type}:${payload.id}`),
    threadId: payload.id,
    occurredAt: DateTime.makeUnsafe(T1),
    payload,
  }) as unknown as OrchestrationV2DomainEvent;

const makeHarness = Effect.fn("makeArtifactWatchHarness")(function* (options: {
  readonly threads: ReadonlyArray<FakeThread>;
  readonly files: Record<string, string>;
}) {
  const files = new Map(Object.entries(options.files).map(([p, at]) => [p, Date.parse(at)]));
  const inodes = new Map<string, number>();
  const directories = new Set([...files.keys()].map((p) => p.slice(0, p.lastIndexOf("/"))));
  const watches: Array<FakeWatch> = [];
  const observed: Array<ObserveCommand> = [];
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const pulls = yield* Queue.unbounded<void>();
  const activation = yield* Deferred.make<void>();

  const watchDirectory = ((directory: string, listener: (event: string, name: string) => void) => {
    if (!directories.has(directory)) throw new Error(`ENOENT: ${directory}`);
    let onError = () => {};
    const watch: FakeWatch = {
      directory,
      closed: false,
      emit: (name) => listener("rename", name),
      fail: () => onError(),
    };
    watches.push(watch);
    const watcher = {
      close: () => {
        watch.closed = true;
      },
      on: (_event: "error", handler: () => void) => {
        onError = handler;
        return watcher;
      },
    };
    return watcher as unknown as ArtifactDirectoryWatcher;
  }) as unknown as typeof ArtifactDirectoryWatch.Service;

  const snapshot = {
    schemaVersion: 1,
    snapshotSequence: 0,
    threads: options.threads,
    archivedThreads: [],
  } as unknown as OrchestrationV2ThreadShellSnapshot;

  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        command.type === "thread.artifact.observe"
          ? Effect.sync(() => observed.push(command)).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            )
          : Effect.die(new Error(`Unexpected command: ${command.type}`)),
      getShellSnapshot: () => Effect.succeed(snapshot),
      // Each pull marks the previous event handled, since the consumer pulls only after it.
      streamDomainEvents: Stream.fromEffectRepeat(
        Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
      ),
    }),
    FileSystem.layerNoop({
      stat: (path) => {
        const mtime = files.get(path);
        return mtime === undefined
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "stat",
                pathOrDescriptor: path,
              }),
            )
          : Effect.succeed({
              mtime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(mtime))),
              ino: Option.fromNullishOr(inodes.get(path)),
            } as unknown as FileSystem.File.Info);
      },
    }),
    Path.layer,
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
    Layer.succeed(ArtifactDirectoryWatch, watchDirectory),
  );

  const context = yield* Layer.build(ArtifactWatchReactor.layer.pipe(Layer.provide(dependencies)));
  yield* Deferred.succeed(activation, undefined);
  const reactor = Context.get(context, ArtifactWatchReactor.ArtifactWatchReactor);
  // The first pull follows the startup snapshot's enqueue.
  yield* Queue.take(pulls);
  yield* reactor.drain;

  const openWatches = () => watches.filter((watch) => !watch.closed).map((w) => w.directory);
  return {
    files,
    inodes,
    directories,
    watches,
    observed,
    openWatches,
    send: (event: OrchestrationV2DomainEvent) =>
      Queue.offer(events, event).pipe(
        Effect.andThen(Queue.take(pulls)),
        Effect.andThen(reactor.drain),
      ),
    /** Reports file events from the open watcher on `directory`, then lets them settle. */
    change: (directory: string, ...names: ReadonlyArray<string>) =>
      Effect.sync(() => {
        const watch = watches.find((w) => w.directory === directory && !w.closed);
        for (const name of names) watch?.emit(name);
      }).pipe(
        Effect.andThen(TestClock.adjust(ArtifactWatchReactor.ARTIFACT_CHANGE_SETTLE)),
        Effect.andThen(reactor.drain),
      ),
  };
});

const summary = (command: ObserveCommand) => ({
  threadId: command.threadId,
  path: command.path,
  updatedAt: command.updatedAt,
  missing: command.missing,
});

describe("ArtifactWatchReactor", () => {
  it.effect("reconciles at start, then reports each settled edit once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          threads: [thread("a", [link("/docs/a.html")]), thread("b", [link("/docs/b.md")])],
          // Edited while the server was down, and untouched since its link.
          files: { "/docs/a.html": T1, "/docs/b.md": T0 },
        });
        assert.deepStrictEqual(fixture.openWatches(), ["/docs"]);
        assert.deepStrictEqual(fixture.observed.map(summary), [
          { threadId: ThreadId.make("a"), path: "/docs/a.html", updatedAt: T1, missing: false },
        ]);

        fixture.files.set("/docs/b.md", Date.parse(T2));
        yield* fixture.change("/docs", "b.md", "b.md", "other.txt", "b.md");
        // A replacement carrying an older mtime, as `cp -p` leaves, is a change too.
        fixture.files.set("/docs/a.html", Date.parse(EARLIER));
        yield* fixture.change("/docs", "a.html");
        // One that kept the same mtime reports a millisecond on, once.
        yield* fixture.send(
          threadEvent(
            "thread.metadata-updated",
            thread("b", [link("/docs/b.md", { updatedAt: T2 })]),
          ),
        );
        fixture.inodes.set("/docs/b.md", 2);
        yield* fixture.change("/docs", "b.md");
        const bumped = "2026-10-30T10:10:00.001Z";
        yield* fixture.send(
          threadEvent(
            "thread.metadata-updated",
            thread("b", [link("/docs/b.md", { updatedAt: bumped })]),
          ),
        );
        assert.deepStrictEqual(fixture.observed.slice(1).map(summary), [
          { threadId: ThreadId.make("b"), path: "/docs/b.md", updatedAt: T2, missing: false },
          {
            threadId: ThreadId.make("a"),
            path: "/docs/a.html",
            updatedAt: EARLIER,
            missing: false,
          },
          { threadId: ThreadId.make("b"), path: "/docs/b.md", updatedAt: bumped, missing: false },
        ]);
      }),
    ),
  );

  it.effect("marks a removed file missing and a restored one present", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          threads: [thread("a", [link("/docs/a.html")])],
          files: { "/docs/a.html": T0 },
        });
        fixture.files.delete("/docs/a.html");
        yield* fixture.change("/docs", "a.html");
        yield* fixture.send(
          threadEvent(
            "thread.metadata-updated",
            thread("a", [link("/docs/a.html", { missing: true })]),
          ),
        );
        // A restored copy no newer than the link still clears `missing`.
        fixture.files.set("/docs/a.html", Date.parse(T0));
        yield* fixture.change("/docs", "a.html");
        assert.deepStrictEqual(
          fixture.observed.map((command) => [command.updatedAt, command.missing]),
          [
            [T0, true],
            [T0, false],
          ],
        );

        // A removed directory hands its watch to its parent until it is recreated.
        fixture.directories.add("/");
        fixture.files.delete("/docs/a.html");
        fixture.directories.delete("/docs");
        yield* fixture.change("/docs", "docs");
        assert.deepStrictEqual(fixture.openWatches(), ["/"]);
        fixture.directories.add("/docs");
        fixture.files.set("/docs/a.html", Date.parse(T2));
        yield* fixture.change("/", "other", "docs");
        assert.deepStrictEqual(fixture.openWatches(), ["/docs"]);

        // A failed watcher rewatches on its own, here on the parent while the directory is gone.
        yield* fixture.send(
          threadEvent(
            "thread.metadata-updated",
            thread("a", [link("/docs/a.html", { updatedAt: T2 })]),
          ),
        );
        fixture.files.delete("/docs/a.html");
        fixture.directories.delete("/docs");
        fixture.watches.find((w) => w.directory === "/docs" && !w.closed)?.fail();
        yield* fixture.change("/docs");
        assert.deepStrictEqual(fixture.openWatches(), ["/"]);
        assert.deepStrictEqual(fixture.observed.slice(2).map(summary), [
          { threadId: ThreadId.make("a"), path: "/docs/a.html", updatedAt: T2, missing: false },
          { threadId: ThreadId.make("a"), path: "/docs/a.html", updatedAt: T2, missing: true },
        ]);
      }),
    ),
  );

  it.effect("closes a shared directory watcher only with its last active link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = [link("/docs/a.html")];
        const b = [link("/docs/b.md")];
        const fixture = yield* makeHarness({
          threads: [thread("a", a), thread("b", b)],
          files: { "/docs/a.html": T0, "/docs/b.md": T0 },
        });
        yield* fixture.send(threadEvent("thread.metadata-updated", thread("a", [])));
        assert.deepStrictEqual(fixture.openWatches(), ["/docs"]);
        yield* fixture.send(threadEvent("thread.archived", thread("b", b, "archived")));
        assert.deepStrictEqual(fixture.openWatches(), []);

        yield* fixture.send(threadEvent("thread.unarchived", thread("b", b)));
        assert.deepStrictEqual(fixture.openWatches(), ["/docs"]);
        yield* fixture.send(threadEvent("thread.deleted", thread("b", b, "deleted")));
        assert.deepStrictEqual(fixture.openWatches(), []);
        assert.lengthOf(fixture.watches, 2);
        assert.lengthOf(fixture.observed, 0);
      }),
    ),
  );

  it.effect(
    "reads a link in a missing directory as missing until a later update can watch it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeHarness({
            threads: [thread("a", [link("/gone/plan.md")])],
            files: {},
          });
          // A relink resets `missing`; the file is still gone, so the check reports it again.
          const relinked = threadEvent(
            "thread.metadata-updated",
            thread("a", [link("/gone/plan.md", { updatedAt: T1 })]),
          );
          yield* fixture.send(relinked);
          assert.deepStrictEqual(fixture.openWatches(), []);

          // The next update for the thread retries the watch, which rereads every file it covers.
          fixture.directories.add("/gone");
          fixture.files.set("/gone/plan.md", Date.parse(T2));
          yield* fixture.send(relinked);
          assert.deepStrictEqual(fixture.openWatches(), ["/gone"]);
          assert.deepStrictEqual(
            fixture.observed.map((command) => [command.updatedAt, command.missing]),
            [
              [T0, true],
              [T1, true],
              [T2, false],
            ],
          );
        }),
      ),
  );
});
