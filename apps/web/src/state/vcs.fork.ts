import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { vcsEnvironment } from "./vcs";

const worktrunkStatusAtom = Atom.family(
  (status: ReturnType<typeof vcsEnvironment.status> | null) =>
    status === null
      ? Atom.make(false)
      : Atom.map(status, (result) => AsyncResult.getOrElse(result, () => null)?.worktrunk === true),
);

export function useWorktrunkStatusFork(status: ReturnType<typeof vcsEnvironment.status> | null) {
  return useAtomValue(worktrunkStatusAtom(status));
}
