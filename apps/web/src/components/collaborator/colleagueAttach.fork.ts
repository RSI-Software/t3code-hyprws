// Fork-only (colleague-collab): which saved colleagues one window attaches, and when it tries again.
import type { ColleagueFork, EnvironmentId } from "@t3tools/contracts";

/**
 * Attaches each colleague the catalog lacks, one attach in flight per colleague. A failed attach
 * is tried again with the next list (a change, or a resubscribe after a reconnect) or the next
 * `retry`, since a colleague's server gives no sign it is back. A re-save (new savedAt) is a new
 * attach.
 */
export function createColleagueAttacherFork() {
  const tried = new Map<string, { list: ReadonlyArray<ColleagueFork>; retry: number }>();
  const inFlight = new Set<string>();
  return (input: {
    readonly colleagues: ReadonlyArray<ColleagueFork>;
    readonly known: ReadonlySet<EnvironmentId>;
    readonly retry: number;
    readonly attach: (colleague: ColleagueFork) => Promise<unknown>;
  }) => {
    const started: Promise<unknown>[] = [];
    for (const colleague of input.colleagues) {
      const key = `${colleague.subject}:${colleague.savedAt}`;
      const last = tried.get(key);
      if (input.known.has(colleague.environmentId) || inFlight.has(key)) continue;
      if (last?.list === input.colleagues && last.retry === input.retry) continue;
      tried.set(key, { list: input.colleagues, retry: input.retry });
      inFlight.add(key);
      started.push(input.attach(colleague).finally(() => inFlight.delete(key)));
    }
    return Promise.all(started);
  };
}
