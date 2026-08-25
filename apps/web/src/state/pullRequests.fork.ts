// Fork-owned: the per-environment merged query with a per-environment error
// list, for commit `9f92309411` (feat(issues): add GitHub Issues surface scoped
// to project windows). The upstream `pullRequests.ts` keeps the single-error
// view the pull-request pages need; the GitHub Issues hub needs every failing
// environment, so this sibling mirrors the upstream query with an `errors`
// array instead of a single `error` string. Nothing upstream imports this file.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { formatEnvironmentQueryError } from "./query";
import type { EnvironmentQueryTarget } from "./pullRequests";

export interface MergedEnvironmentQueryErrorFork {
  readonly environmentId: EnvironmentId;
  readonly message: string;
}

interface MergedEnvironmentQueryForkView<A> {
  /** One entry per query target that has answered, in the order the targets were given. */
  readonly values: ReadonlyArray<readonly [EnvironmentId, A]>;
  /** Every environment that failed. Others may still have answered — these are not fatal. */
  readonly errors: ReadonlyArray<MergedEnvironmentQueryErrorFork>;
  /** True while any targeted environment is still waiting for an answer. */
  readonly isPending: boolean;
}

/**
 * The same per-environment query read across several environments at once. React cannot subscribe
 * to a list of atoms whose length changes, so the fan-out happens inside one derived atom keyed by
 * the targets — the same shape the cross-environment thread search uses.
 *
 * An environment that fails contributes nothing rather than blanking the page: these lists are a
 * union, and one unreachable machine should not hide the others' rows.
 */
export function createMergedEnvironmentQueryFork<Input, A>(
  label: string,
  atomFor: (
    target: EnvironmentQueryTarget<Input>,
  ) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get): MergedEnvironmentQueryForkView<A> => {
      const targets = JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>;
      const values: Array<readonly [EnvironmentId, A]> = [];
      const errors: MergedEnvironmentQueryErrorFork[] = [];
      let isPending = false;
      for (const target of targets) {
        const result = get(atomFor(target));
        isPending ||= result.waiting;
        if (result._tag === "Failure") {
          errors.push({
            environmentId: target.environmentId,
            message: formatEnvironmentQueryError(result.cause),
          });
        }
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) values.push([target.environmentId, value]);
      }
      return { values, errors, isPending };
    }).pipe(Atom.withLabel(`${label}:${key}`)),
  );
  const empty = Atom.make<MergedEnvironmentQueryForkView<A>>({
    values: [],
    errors: [],
    isPending: false,
  }).pipe(Atom.withLabel(`${label}:empty`));
  return function useMergedQueryFork(targets: ReadonlyArray<EnvironmentQueryTarget<Input>>) {
    const key = JSON.stringify(targets);
    const view = useAtomValue(targets.length === 0 ? empty : family(key));
    const refresh = useCallback(
      (override?: ReadonlyArray<EnvironmentQueryTarget<Input>>) => {
        const refreshTargets =
          override ?? (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>);
        for (const atom of new Set(refreshTargets.map(atomFor))) {
          appAtomRegistry.refresh(atom);
        }
      },
      [key],
    );
    return { ...view, refresh };
  };
}
