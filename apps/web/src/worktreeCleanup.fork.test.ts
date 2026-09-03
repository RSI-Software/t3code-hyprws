import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { getOrphanedWorktreePathsForThreads, scopedWorktreePathKey } from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    checkpoints: [],
    activities: [],
    proposedPlans: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("getOrphanedWorktreePathsForThreads", () => {
  it("returns nothing when no thread in the batch has a worktree", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: null }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: null }),
    ];
    const result = getOrphanedWorktreePathsForThreads(
      threads,
      new Set([ThreadId.make("thread-1"), ThreadId.make("thread-2")]),
    );
    expect(result).toEqual([]);
  });

  it("collects one path per deleted thread that owns its worktree alone", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "/tmp/repo/worktrees/a" }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/repo/worktrees/b" }),
      makeThread({ id: ThreadId.make("thread-3"), worktreePath: "/tmp/repo/worktrees/c" }),
    ];
    const result = getOrphanedWorktreePathsForThreads(
      threads,
      new Set([ThreadId.make("thread-1"), ThreadId.make("thread-2")]),
    );
    expect(result).toEqual(["/tmp/repo/worktrees/a", "/tmp/repo/worktrees/b"]);
  });

  it("skips a worktree a surviving thread still points at", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "/tmp/repo/worktrees/shared" }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/repo/worktrees/shared" }),
    ];
    const result = getOrphanedWorktreePathsForThreads(
      threads,
      new Set([ThreadId.make("thread-1")]),
    );
    expect(result).toEqual([]);
  });

  it("counts a shared worktree once when the whole batch releases it", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "/tmp/repo/worktrees/shared" }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/repo/worktrees/shared" }),
    ];
    const result = getOrphanedWorktreePathsForThreads(
      threads,
      new Set([ThreadId.make("thread-1"), ThreadId.make("thread-2")]),
    );
    expect(result).toEqual(["/tmp/repo/worktrees/shared"]);
  });

  it("ignores blank worktree paths", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "   " }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/repo/worktrees/a" }),
    ];
    const result = getOrphanedWorktreePathsForThreads(
      threads,
      new Set([ThreadId.make("thread-1"), ThreadId.make("thread-2")]),
    );
    expect(result).toEqual(["/tmp/repo/worktrees/a"]);
  });
});

describe("scopedWorktreePathKey", () => {
  it("keeps the same path in different environments apart", () => {
    const local = scopedWorktreePathKey("local", "/tmp/repo/worktrees/a");
    const remote = scopedWorktreePathKey("remote", "/tmp/repo/worktrees/a");
    expect(local).not.toBe(remote);
  });

  it("is stable for the same environment and path", () => {
    expect(scopedWorktreePathKey("local", "/tmp/repo/worktrees/a")).toBe(
      scopedWorktreePathKey("local", "/tmp/repo/worktrees/a"),
    );
  });
});
