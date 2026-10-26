import {
  EnvironmentInternalError,
  THREAD_GROUP_TITLE_CLIENT_TIMEOUT_MS_FORK,
} from "@t3tools/contracts";
import { RemoteEnvironmentAuthTimeoutError } from "@t3tools/client-runtime/rpc";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadGroup } from "../state/threadGroups";
import {
  createThreadGroupTitleOwner,
  threadGroupTitleFailureDescription,
  type ThreadGroupTitleDeps,
} from "./SidebarThreadGroup.title";

const timeout = (): TitleResult =>
  AsyncResult.failure(
    Cause.fail(
      new RemoteEnvironmentAuthTimeoutError(
        "https://environment.example.test/api/orchestration/thread-group-title",
        THREAD_GROUP_TITLE_CLIENT_TIMEOUT_MS_FORK,
      ),
    ),
  );

describe("threadGroupTitleFailureDescription", () => {
  it("names the budget a timed-out request ran out of", () => {
    expect(threadGroupTitleFailureDescription(timeout())).toBe(
      "The text generation model did not answer within 185 seconds.",
    );
  });

  it("reports a server failure", () => {
    const error = new EnvironmentInternalError({
      code: "internal_error",
      reason: "thread_group_title_generation_failed",
      traceId: "trace-1",
    });
    expect(threadGroupTitleFailureDescription(AsyncResult.failure(Cause.fail(error)))).toBe(
      error.message,
    );
  });

  it("stays quiet for a success or a cancellation", () => {
    expect(threadGroupTitleFailureDescription(AsyncResult.success({ title: "x" }))).toBeNull();
    expect(threadGroupTitleFailureDescription(AsyncResult.failure(Cause.interrupt()))).toBeNull();
  });
});

interface Thread {
  readonly key: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
}
type TitleResult = AtomCommandResult<{ readonly title: string }, unknown>;
type ToastOptions = Parameters<ThreadGroupTitleDeps<Thread>["toasts"]["add"]>[0];

const thread = (key: string, projectId = "p-a"): Thread => ({
  key,
  environmentId: "env",
  projectId,
  title: `Thread ${key}`,
});

/** The app owner over an in-memory store; each sidebar mount binds its own command. */
function harness() {
  let threads = [thread("a1"), thread("a2"), thread("b1", "p-b"), thread("b2", "p-b")];
  let groups: SidebarThreadGroup[] = [
    { id: "g", title: "New group", threadIds: ["a1", "a2"], collapsed: false },
    { id: "h", title: "Other", threadIds: ["b1", "b2"], collapsed: false },
  ];
  const calls: {
    readonly projectId: string;
    readonly memberTitles: readonly string[];
    readonly parentTitle?: string;
    readonly previousTitle?: string;
  }[] = [];
  const pending: ((result: TitleResult) => void)[] = [];
  const open = new Map<string, ToastOptions>();
  const generating: ReadonlySet<string>[] = [];
  let nextToast = 0;
  const owner = createThreadGroupTitleOwner<Thread>({
    readGroups: () => groups,
    readThreads: () => threads,
    keyOf: (candidate) => candidate.key,
    renameIfCurrent: (groupId, _expected, title) => {
      groups = groups.map((group) => (group.id === groupId ? { ...group, title } : group));
    },
    toasts: {
      add: (options) => {
        const id = `toast-${nextToast++}`;
        open.set(id, options);
        return id;
      },
      close: (id) => {
        open.get(id)?.onClose();
        open.delete(id);
      },
    },
  });
  owner.subscribe(() => generating.push(owner.generating()));
  // A sidebar mount: a fresh command bound to the one owner.
  const mount = () =>
    owner.bind({
      generate: ({ input }) => {
        calls.push(input);
        return new Promise((resolve) => pending.push(resolve));
      },
    });
  mount();
  // The request publishes its in-flight set from `finally`, after it has handled the result.
  const settle = async (result: TitleResult) => {
    const handled = new Promise<void>((resolve) => {
      const unsubscribe = owner.subscribe(() => {
        unsubscribe();
        resolve();
      });
    });
    pending.shift()!(result);
    await handled;
  };
  const clickRetry = () => {
    const [toast] = open.values();
    (toast!.actionProps!.onClick as () => void)();
  };
  const update = (groupId: string, next: Partial<SidebarThreadGroup> | null) => {
    groups = groups.flatMap((group) =>
      group.id !== groupId ? [group] : next === null ? [] : [{ ...group, ...next }],
    );
    owner.pruneStale();
  };
  const requestA = (previousTitle?: string) =>
    owner.request({
      groupId: "g",
      members: threads.slice(0, 2),
      expectedGroup: groups[0]!,
      ...(previousTitle === undefined ? {} : { previousTitle }),
    });
  const retitle = (key: string, title: string) => {
    threads = threads.map((candidate) =>
      candidate.key === key ? { ...candidate, title } : candidate,
    );
  };
  return {
    mount,
    retitle,
    calls,
    open,
    generating,
    settle,
    clickRetry,
    update,
    requestA,
    groups: () => groups,
    threads: () => threads,
    owner,
  };
}

describe("createThreadGroupTitleOwner", () => {
  it("keeps a failure on screen, labelled with its group", async () => {
    const h = harness();
    void h.requestA();
    await h.settle(timeout());
    const [toast] = h.open.values();
    expect(toast).toMatchObject({
      title: 'Failed to name "New group" (2 threads)',
      description: "The text generation model did not answer within 185 seconds.",
      timeout: 0,
    });
    expect(h.groups()[0]!.title).toBe("New group");
  });

  it("stays silent for a cancellation", async () => {
    const h = harness();
    void h.requestA();
    await h.settle(AsyncResult.failure(Cause.interrupt()));
    expect(h.open.size).toBe(0);
  });

  it("retries from the store, whatever the sidebar scope shows", async () => {
    const h = harness();
    void h.requestA();
    await h.settle(timeout());
    // Retry reads groups and threads directly, never the scoped sidebar list.
    h.clickRetry();
    expect(h.open.size).toBe(0);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.memberTitles).toEqual(["Thread a1", "Thread a2"]);
    await h.settle(AsyncResult.success({ title: "Named" }));
    expect(h.groups()[0]!.title).toBe("Named");
  });

  it("retries a regenerate against the current title", async () => {
    const h = harness();
    void h.requestA("New group");
    await h.settle(timeout());
    h.clickRetry();
    expect(h.calls[1]!.previousTitle).toBe("New group");
  });

  it("ignores a second request for a group while one runs", async () => {
    const h = harness();
    void h.requestA();
    void h.requestA("New group");
    expect(h.calls).toHaveLength(1);
    expect(h.generating.at(-1)).toEqual(new Set(["g"]));
    await h.settle(timeout());
    expect(h.generating.at(-1)).toEqual(new Set());
  });

  it("closes a failure toast when the group asks again", async () => {
    const h = harness();
    void h.requestA();
    await h.settle(timeout());
    void h.requestA("New group");
    expect(h.open.size).toBe(0);
    await h.settle(timeout());
    expect(h.open.size).toBe(1);
  });

  it("drops a failure for a group that changed while it ran", async () => {
    const h = harness();
    void h.requestA();
    h.update("g", { title: "Mine" });
    await h.settle(timeout());
    expect(h.open.size).toBe(0);
  });

  it("closes a failure toast on rename, member change, or dissolve", async () => {
    for (const change of [
      { title: "Mine" },
      { threadIds: ["a1", "a2", "a3"] },
      null,
    ] satisfies (Partial<SidebarThreadGroup> | null)[]) {
      const h = harness();
      void h.requestA();
      await h.settle(timeout());
      expect(h.open.size).toBe(1);
      h.update("g", change);
      expect(h.open.size).toBe(0);
    }
  });

  it("keeps one controller across a sidebar remount", async () => {
    const h = harness();
    void h.requestA();
    await h.settle(timeout());
    // Settings unmounts the sidebar; the failure toast stays up.
    h.mount();
    h.clickRetry();
    void h.requestA("New group");
    expect(h.calls).toHaveLength(2);
    expect(h.generating.at(-1)).toEqual(new Set(["g"]));
    await h.settle(timeout());
    h.update("g", null);
    expect(h.open.size).toBe(0);
  });

  it("names a group spanning projects from its first member's project", () => {
    const h = harness();
    void h.owner.request({
      groupId: "x",
      members: [h.threads()[2]!, h.threads()[0]!],
      expectedGroup: { title: "New group", threadIds: ["b1", "a1"] },
    });
    expect(h.calls[0]).toEqual({ projectId: "p-b", memberTitles: ["Thread b1", "Thread a1"] });
  });

  it("regenerates with the parent leading, not as the newest member", () => {
    const h = harness();
    h.update("h", { parentThreadId: "b2" });
    h.owner.regenerate("h");
    expect(h.calls[0]).toEqual({
      projectId: "p-b",
      memberTitles: ["Thread b1"],
      parentTitle: "Thread b2",
      previousTitle: "Other",
    });
  });

  it("retries with thread titles edited while the sidebar was away", async () => {
    const h = harness();
    void h.requestA();
    await h.settle(timeout());
    // Settings unmounts the sidebar; a thread is renamed before Retry.
    h.retitle("a1", "Renamed thread");
    h.clickRetry();
    expect(h.calls[1]!.memberTitles).toEqual(["Renamed thread", "Thread a2"]);
  });
});
