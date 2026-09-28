import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  windowCommandRequest,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  dispatchWindowRequest,
  resolveLaunchRequest,
  type WindowCreateRequest,
  type WindowDispatchOps,
} from "./WindowDispatch.fork.ts";

const WINDOW_A = "00000000-0000-4000-8000-00000000000a";
const WINDOW_B = "00000000-0000-4000-8000-00000000000b";

const projectRef = (name: string): ScopedProjectRef => ({
  environmentId: EnvironmentId.make(`environment-${name}`),
  projectId: ProjectId.make(`project-${name}`),
});

interface FakeWindows {
  /** Open windows by id, most recent last. */
  readonly open: Array<{ readonly id: string; readonly showing: ScopedProjectRef | null }>;
}

/** Records every window operation the table asks for, as plain strings. */
const makeOps = (windows: FakeWindows) => {
  const calls: string[] = [];
  const created: WindowCreateRequest[] = [];
  const ops: WindowDispatchOps<string, never> = {
    create: (request) =>
      Effect.sync(() => {
        created.push(request);
        calls.push("create");
        const showing = request.seed === "all-projects" ? null : request.seed;
        windows.open.push({ id: `created-${created.length}`, showing });
      }),
    openPrimary: Effect.sync(() => void calls.push("open-primary")),
    createPrimary: Effect.sync(() => void calls.push("create-primary")),
    mostRecent: Effect.sync(() => Option.fromNullishOr(windows.open.at(-1)?.id)),
    showing: (ref) =>
      Effect.sync(() =>
        Option.fromNullishOr(
          windows.open.find(
            (window) =>
              window.showing?.environmentId === ref.environmentId &&
              window.showing.projectId === ref.projectId,
          )?.id,
        ),
      ),
    byId: (windowId) =>
      Effect.sync(() => Option.fromNullishOr(windows.open.find((w) => w.id === windowId)?.id)),
    reveal: (window) => Effect.sync(() => void calls.push(`reveal:${window}`)),
  };
  return { ops, calls, created } as const;
};

describe("window dispatch table", () => {
  it.effect("New Window: creates at / on every project, even with windows open", () =>
    Effect.gen(function* () {
      const fake = makeOps({ open: [{ id: WINDOW_A, showing: null }] });
      yield* dispatchWindowRequest(fake.ops)({ kind: "new-window" });
      assert.deepEqual(fake.calls, ["create"]);
      assert.deepEqual(fake.created, [{ route: "/", seed: "all-projects" }]);
    }),
  );

  it.effect("Open in New Window: creates at that route with the seed, never reusing", () =>
    Effect.gen(function* () {
      const ref = projectRef("one");
      const fake = makeOps({ open: [{ id: WINDOW_A, showing: ref }] });
      const route = "/environment-one/thread-1";
      yield* dispatchWindowRequest(fake.ops)({ kind: "open-in-new-window", route, seed: ref });
      assert.deepEqual(fake.calls, ["create"]);
      assert.deepEqual(fake.created, [{ route, seed: ref }]);
    }),
  );

  it.effect("second launch or dock: focuses the most recent window, else creates", () =>
    Effect.gen(function* () {
      const withWindows = makeOps({
        open: [
          { id: WINDOW_A, showing: null },
          { id: WINDOW_B, showing: projectRef("one") },
        ],
      });
      yield* dispatchWindowRequest(withWindows.ops)({ kind: "activate" });
      assert.deepEqual(withWindows.calls, [`reveal:${WINDOW_B}`]);

      const empty = makeOps({ open: [] });
      yield* dispatchWindowRequest(empty.ops)({ kind: "activate" });
      assert.deepEqual(empty.calls, ["create-primary"]);
    }),
  );

  it.effect("deep link: reuses a window showing the project, else creates it filtered", () =>
    Effect.gen(function* () {
      const ref = projectRef("one");
      const showing = makeOps({
        open: [
          { id: WINDOW_A, showing: ref },
          { id: WINDOW_B, showing: null },
        ],
      });
      yield* dispatchWindowRequest(showing.ops)({ kind: "project-link", ref });
      assert.deepEqual(showing.calls, [`reveal:${WINDOW_A}`]);

      const other = makeOps({ open: [{ id: WINDOW_B, showing: projectRef("two") }] });
      yield* dispatchWindowRequest(other.ops)({ kind: "project-link", ref });
      assert.deepEqual(other.calls, ["create"]);
      assert.deepEqual(other.created, [{ route: "/", seed: ref }]);
    }),
  );

  it.effect("mod+alt+o reuses the project's window; Open in New Window always creates", () =>
    Effect.gen(function* () {
      const ref = projectRef("one");
      const fake = makeOps({ open: [{ id: WINDOW_A, showing: null }] });
      const dispatch = dispatchWindowRequest(fake.ops);

      const press = windowCommandRequest("window.openProject", ref);
      assert.isNotNull(press);
      if (press === null) return;
      yield* dispatch(press);
      yield* dispatch(press);
      assert.equal(fake.created.length, 1);
      assert.deepEqual(fake.calls, ["create", "reveal:created-1"]);

      const route = "/environment-one/thread-1";
      yield* dispatch({ kind: "open-in-new-window", route, seed: ref });
      yield* dispatch({ kind: "open-in-new-window", route, seed: ref });
      assert.equal(fake.created.length, 3);
    }),
  );

  it.effect("focus by id: focuses an open window and never resurrects a closed one", () =>
    Effect.gen(function* () {
      const fake = makeOps({ open: [{ id: WINDOW_A, showing: null }] });
      yield* dispatchWindowRequest(fake.ops)({ kind: "focus", windowId: WINDOW_A });
      yield* dispatchWindowRequest(fake.ops)({ kind: "focus", windowId: WINDOW_B });
      yield* dispatchWindowRequest(fake.ops)({ kind: "focus", windowId: "not-a-window-id" });
      assert.deepEqual(fake.calls, [`reveal:${WINDOW_A}`]);
    }),
  );

  it.effect("OAuth callback: keeps the primary window's reveal-or-create path", () =>
    Effect.gen(function* () {
      const fake = makeOps({ open: [{ id: WINDOW_A, showing: projectRef("one") }] });
      yield* dispatchWindowRequest(fake.ops)({ kind: "callback" });
      assert.deepEqual(fake.calls, ["open-primary"]);
    }),
  );

  it("classifies launch argv into its table row", () => {
    assert.deepEqual(resolveLaunchRequest(["t3code"]), { kind: "activate" });
    assert.deepEqual(resolveLaunchRequest(["t3code", "--project", "env", "proj"]), {
      kind: "project-link",
      ref: { environmentId: EnvironmentId.make("env"), projectId: ProjectId.make("proj") },
    });
    assert.deepEqual(resolveLaunchRequest(["t3code", "t3code://app/project/env/proj"]), {
      kind: "project-link",
      ref: { environmentId: EnvironmentId.make("env"), projectId: ProjectId.make("proj") },
    });
    assert.deepEqual(resolveLaunchRequest(["t3code", "t3code://auth/callback?code=1"]), {
      kind: "callback",
    });
  });
});
