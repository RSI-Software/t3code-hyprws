import { EnvironmentId, IsoDateTime, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  colleagueOutboxReadyFork,
  flushColleagueOutboxFork,
  type OutboxRouteFork,
} from "./colleagueOutbox.logic.fork";

const queued = (id: string, environment: string, thread: string) => ({
  id,
  environmentId: EnvironmentId.make(environment),
  threadId: ThreadId.make(thread),
  text: id,
  queuedAt: IsoDateTime.make("2026-11-27T00:00:00.000Z"),
});

describe("flushColleagueOutboxFork", () => {
  it("delivers each thread in order, stops a thread at a failure, and holds an offline colleague", async () => {
    const outbox = [
      queued("a1", "env-alex", "t1"),
      queued("j1", "env-jordan", "t2"),
      queued("a2", "env-alex", "t1"),
      queued("a3", "env-alex", "t3"),
      queued("a4", "env-alex", "t1"),
    ];
    const routes: Record<string, OutboxRouteFork> = {
      "env-alex:t1": "send",
      "env-alex:t3": "approve",
      "env-jordan:t2": null,
    };
    const delivered: string[] = [];
    const removed: string[] = [];

    await flushColleagueOutboxFork(outbox, {
      route: (message) => routes[`${message.environmentId}:${message.threadId}`] ?? null,
      deliver: async (message, route) => {
        delivered.push(`${message.id}:${route}`);
        return message.id !== "a2";
      },
      remove: async (message) => {
        removed.push(message.id);
        return true;
      },
    });

    expect(delivered).toEqual(["a1:send", "a3:approve", "a2:send"]);
    expect(removed).toEqual(["a1", "a3"]);
  });

  it("is not ready while each thread's oldest message is held, even if a later one could go", () => {
    const outbox = [queued("a1", "env-alex", "t1"), queued("a2", "env-alex", "t1")];
    expect(
      colleagueOutboxReadyFork(outbox, (message) => (message.id === "a1" ? null : "send")),
    ).toBe(false);
    expect(colleagueOutboxReadyFork(outbox, () => "approve")).toBe(true);
  });
});
