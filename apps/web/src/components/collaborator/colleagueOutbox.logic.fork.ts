import type { ColleagueQueuedMessageFork } from "@t3tools/contracts";

/** How a queued message reaches its thread now: as the share allows, or not yet. */
export type OutboxRouteFork = "send" | "approve" | null;

/**
 * Delivers queued messages oldest first, one thread at a time, removing each once it lands. A
 * thread stops at its first message that cannot go, so a later one never overtakes it.
 */
export async function flushColleagueOutboxFork(
  queued: ReadonlyArray<ColleagueQueuedMessageFork>,
  io: {
    readonly route: (message: ColleagueQueuedMessageFork) => OutboxRouteFork;
    readonly deliver: (
      message: ColleagueQueuedMessageFork,
      route: "send" | "approve",
    ) => Promise<boolean>;
    readonly remove: (message: ColleagueQueuedMessageFork) => Promise<boolean>;
  },
): Promise<void> {
  const threads = new Map<string, ColleagueQueuedMessageFork[]>();
  for (const message of queued) {
    const key = `${message.environmentId}:${message.threadId}`;
    threads.set(key, [...(threads.get(key) ?? []), message]);
  }
  await Promise.all(
    [...threads.values()].map(async (messages) => {
      for (const message of messages) {
        const route = io.route(message);
        if (route === null) return;
        if (!(await io.deliver(message, route))) return;
        if (!(await io.remove(message))) return;
      }
    }),
  );
}
