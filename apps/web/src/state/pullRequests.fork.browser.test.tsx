import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useLayoutEffect } from "react";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../test/render";
import { createMergedEnvironmentQueryFork } from "./pullRequests.fork";

type Target = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly state: "open" | "closed" };
};

const environment1 = EnvironmentId.make("environment-1");
const environment2 = EnvironmentId.make("environment-2");

const sources = new Map<EnvironmentId, Atom.Writable<AsyncResult.AsyncResult<string, string>>>();

const useMergedQuery = createMergedEnvironmentQueryFork<{ state: "open" | "closed" }, string>(
  "web-github-issues:test",
  (target) => sources.get(target.environmentId)!,
);

/** One environment reading a fixed list, driven through a real atom registry. */
function fixture(environmentIds: ReadonlyArray<EnvironmentId>) {
  for (const environmentId of environmentIds) {
    sources.set(
      environmentId,
      Atom.make<AsyncResult.AsyncResult<string, string>>(AsyncResult.success("open rows")),
    );
  }
  const stack = new AsyncDisposableStack();
  stack.defer(() => sources.clear());
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());

  let view: ReturnType<typeof useMergedQuery> | undefined;
  function Probe({ targets }: { readonly targets: ReadonlyArray<Target> }) {
    const value = useMergedQuery(targets);
    useLayoutEffect(() => {
      view = value;
    });
    return null;
  }

  return {
    view: () => view,
    set: (environmentId: EnvironmentId, result: AsyncResult.AsyncResult<string, string>) =>
      act(() => registry.set(sources.get(environmentId)!, result)),
    render: async (targets: ReadonlyArray<Target>) => {
      stack.use(
        await render(
          <RegistryContext.Provider value={registry}>
            <Probe targets={targets} />
          </RegistryContext.Provider>,
          { router: false },
        ),
      );
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

const target = (environmentId: EnvironmentId): Target => ({
  environmentId,
  input: { state: "open" },
});

/** What the list query answers when a refresh fails after a successful read. */
const failedRefresh = AsyncResult.failureWithPrevious(Cause.fail("host unreachable"), {
  previous: Option.some(AsyncResult.success("open rows")),
});

describe("createMergedEnvironmentQueryFork", () => {
  it("reads a successful environment as current rows", async () => {
    await using scope = fixture([environment1]);
    await scope.render([target(environment1)]);
    expect(scope.view()).toMatchObject({
      values: [[environment1, "open rows"]],
      errors: [],
      isPending: false,
      stale: false,
    });
  });

  it("keeps rows a failed refresh had read and flags them stale", async () => {
    await using scope = fixture([environment1]);
    await scope.render([target(environment1)]);
    await scope.set(environment1, failedRefresh);
    expect(scope.view()?.values).toEqual([[environment1, "open rows"]]);
    expect(scope.view()?.errors.map((error) => error.environmentId)).toEqual([environment1]);
    expect(scope.view()?.stale).toBe(true);
  });

  it("does not flag a first read that failed without listing rows", async () => {
    await using scope = fixture([environment1]);
    await scope.render([target(environment1)]);
    await scope.set(environment1, AsyncResult.failure(Cause.fail("not signed in")));
    expect(scope.view()?.values).toEqual([]);
    expect(scope.view()?.stale).toBe(false);
  });

  it("leaves rows current when only another environment failed its first read", async () => {
    await using scope = fixture([environment1, environment2]);
    await scope.render([target(environment1), target(environment2)]);
    await scope.set(environment2, AsyncResult.failure(Cause.fail("offline")));
    expect(scope.view()?.values).toEqual([[environment1, "open rows"]]);
    expect(scope.view()?.stale).toBe(false);
  });

  it("clears the stale flag once a refresh answers again", async () => {
    await using scope = fixture([environment1]);
    await scope.render([target(environment1)]);
    await scope.set(environment1, failedRefresh);
    expect(scope.view()?.stale).toBe(true);
    await scope.set(environment1, AsyncResult.success("fresh rows"));
    expect(scope.view()?.values).toEqual([[environment1, "fresh rows"]]);
    expect(scope.view()?.stale).toBe(false);
  });
});
