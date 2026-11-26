// Fork-only (colleague-collab): forgets the environment of a colleague who left the saved list.
import type { EnvironmentId } from "@t3tools/contracts";

export interface KnownColleagueFork {
  readonly environmentId: EnvironmentId;
  readonly name: string;
}

/**
 * One window's reconciler. Each window cleans its own in-memory catalog, so it keeps its own last
 * list, seeded with the device's as the window started: a removal made while it was closed, or
 * handled by another window before this one's first list, still applies. A removal that fails
 * stays on the list and is retried with the next one.
 */
export function createColleagueReconcilerFork(
  seed: ReadonlyArray<KnownColleagueFork>,
  write: (list: ReadonlyArray<KnownColleagueFork>) => void,
) {
  let last = seed;
  let queue = Promise.resolve();
  return (input: {
    readonly current: ReadonlyArray<KnownColleagueFork>;
    readonly known: ReadonlySet<EnvironmentId>;
    readonly remove: (environmentId: EnvironmentId) => Promise<boolean>;
    readonly forgotten: (colleague: KnownColleagueFork) => void;
  }) =>
    (queue = queue.then(async () => {
      const kept = new Set(input.current.map((colleague) => colleague.environmentId));
      const failed: KnownColleagueFork[] = [];
      for (const colleague of last) {
        if (kept.has(colleague.environmentId) || !input.known.has(colleague.environmentId))
          continue;
        if (await input.remove(colleague.environmentId)) input.forgotten(colleague);
        else failed.push(colleague);
      }
      last = [
        ...input.current.map(({ environmentId, name }) => ({ environmentId, name })),
        ...failed,
      ];
      write(last);
    }));
}
