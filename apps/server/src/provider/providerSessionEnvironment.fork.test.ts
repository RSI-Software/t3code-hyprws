import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  codexThreadIdentityConfig,
  providerSessionIdentity,
  providerSessionProjectId,
  stripInheritedProviderSessionIdentity,
  withoutProviderSessionIdentity,
  withSessionIdentityWhenKnown,
  withThreadProjects,
} from "@t3tools/provider-core/server/providerSessionEnvironment.fork";

const threadId = "thread-1" as ThreadId;
const projectId = "project-1" as ProjectId;
const leaked = {
  PATH: "/bin",
  T3CODE_PROJECT_ID: "parent-project",
  T3CODE_THREAD_ID: "parent-thread",
};

describe("provider session identity helpers", () => {
  it("removes both ids from a process every thread shares", () => {
    expect(withoutProviderSessionIdentity(leaked)).toEqual({ PATH: "/bin" });
  });

  it("leaves a spawn without a session as built", () => {
    expect(withSessionIdentityWhenKnown(leaked, undefined)).toBe(leaked);
    expect(withSessionIdentityWhenKnown(leaked, { threadId, projectId })).toEqual({
      PATH: "/bin",
      T3CODE_PROJECT_ID: "project-1",
      T3CODE_THREAD_ID: "thread-1",
    });
  });

  it("picks only the identity from a session input", () => {
    expect(
      providerSessionIdentity({ threadId, projectId, providerSessionId: "session-1" } as never),
    ).toEqual({ threadId, projectId });
  });
});

describe("stripInheritedProviderSessionIdentity", () => {
  it.effect("drops the launcher's ids from the server's own environment", () =>
    Effect.gen(function* () {
      const environment: NodeJS.ProcessEnv = { ...leaked };
      yield* stripInheritedProviderSessionIdentity.pipe(
        Effect.provideService(HostProcessEnvironment, environment),
      );
      expect(environment).toEqual({ PATH: "/bin" });
    }),
  );
});

describe("providerSessionProjectId", () => {
  const projections = <E>(shell: Effect.Effect<{ readonly projectId: ProjectId } | null, E>) => ({
    getThreadShell: () => shell,
  });

  it.effect("reads the owning project from the thread shell", () =>
    Effect.gen(function* () {
      expect(
        yield* providerSessionProjectId(projections(Effect.succeed({ projectId })), threadId),
      ).toEqual({ projectId });
    }),
  );

  it.effect("opens without a project when the thread is missing or unreadable", () =>
    Effect.gen(function* () {
      expect(yield* providerSessionProjectId(projections(Effect.succeed(null)), threadId)).toEqual(
        {},
      );
      expect(
        yield* providerSessionProjectId(projections(Effect.fail("projection down")), threadId),
      ).toEqual({});
    }),
  );
});

describe("codexThreadIdentityConfig", () => {
  it("sets both ids for the thread's shell commands", () => {
    expect(codexThreadIdentityConfig({ threadId, projectId })).toEqual({
      shell_environment_policy: {
        set: { T3CODE_PROJECT_ID: "project-1", T3CODE_THREAD_ID: "thread-1" },
      },
    });
  });

  it("sets only the thread id when the project is unknown, and nothing without a thread", () => {
    expect(codexThreadIdentityConfig({ threadId })).toEqual({
      shell_environment_policy: { set: { T3CODE_THREAD_ID: "thread-1" } },
    });
    expect(codexThreadIdentityConfig({})).toEqual({});
  });
});

describe("withThreadProjects", () => {
  type Runtime = Pick<
    ProviderAdapterV2SessionRuntime,
    "ensureThread" | "resumeThread" | "forkThread" | "rollbackThread"
  >;
  const otherThreadId = "thread-2" as ThreadId;
  const providerThread = (appThreadId: ThreadId | null) => ({ appThreadId }) as never;

  // One shared runtime, two threads from different projects, one thread unknown.
  const makeRuntime = () => {
    const seen: Array<{ readonly call: string; readonly projectId: unknown }> = [];
    const record = (call: string) => (input: { readonly projectId?: unknown }) => {
      seen.push({ call, projectId: input.projectId });
      return Effect.succeed(null);
    };
    const runtime = {
      ensureThread: record("ensure"),
      resumeThread: record("resume"),
      forkThread: record("fork"),
      rollbackThread: record("rollback"),
    } as unknown as Runtime;
    const projections = {
      getThreadShell: (id: ThreadId) => Effect.succeed(id === threadId ? { projectId } : null),
    };
    return { seen, wrapped: withThreadProjects(projections, runtime) };
  };

  it.effect("gives each thread call its own thread's project", () =>
    Effect.gen(function* () {
      const { seen, wrapped } = makeRuntime();
      yield* wrapped.ensureThread({ threadId } as never);
      yield* wrapped.resumeThread({ providerThread: providerThread(threadId) } as never);
      yield* wrapped.forkThread({ targetThreadId: threadId } as never);
      yield* wrapped.rollbackThread({ providerThread: providerThread(threadId) } as never);
      expect(seen).toEqual([
        { call: "ensure", projectId },
        { call: "resume", projectId },
        { call: "fork", projectId },
        { call: "rollback", projectId },
      ]);
    }),
  );

  it.effect("passes no project for an unknown thread or one without an app thread", () =>
    Effect.gen(function* () {
      const { seen, wrapped } = makeRuntime();
      yield* wrapped.ensureThread({ threadId: otherThreadId } as never);
      yield* wrapped.resumeThread({ providerThread: providerThread(null) } as never);
      expect(seen).toEqual([
        { call: "ensure", projectId: undefined },
        { call: "resume", projectId: undefined },
      ]);
    }),
  );
});

describe("AcpSessionRuntime spawn environment", () => {
  // The server itself was launched from a tmux pane inside another T3-hosted agent.
  const ambient = { TMUX: "/tmp/tmux-1000/default,1,0", T3CODE_THREAD_ID: "ambient-thread" };
  const withAmbientEnvironment = Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(
        Object.keys(ambient).map((name) => [name, process.env[name]]),
      );
      Object.assign(process.env, ambient);
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  );

  const captureSpawnEnv = (options: Partial<AcpSessionRuntime.AcpSessionRuntimeOptions>) =>
    Effect.gen(function* () {
      yield* withAmbientEnvironment;
      let captured: NodeJS.ProcessEnv | undefined;
      const spawner = ChildProcessSpawner.make((command) => {
        captured = (
          command as unknown as { readonly options: { readonly env?: NodeJS.ProcessEnv } }
        ).options.env;
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "captured",
          }),
        );
      });
      yield* AcpSessionRuntime.make({
        spawn: {
          command: process.execPath,
          args: [],
          env: leaked,
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-test", version: "0.0.0" },
        ...options,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.ignore,
      );
      return captured;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("gives a session agent its own identity over a leaked one", () =>
    Effect.gen(function* () {
      const env = yield* captureSpawnEnv({ sessionIdentity: { threadId, projectId } });
      expect(env?.T3CODE_PROJECT_ID).toBe("project-1");
      expect(env?.T3CODE_THREAD_ID).toBe("thread-1");
      expect(env?.PATH).toBe("/bin");
      expect(env).not.toHaveProperty("TMUX");
    }),
  );

  it.effect("removes a leaked id the session does not know", () =>
    Effect.gen(function* () {
      const env = yield* captureSpawnEnv({ sessionIdentity: { threadId } });
      expect(env?.T3CODE_THREAD_ID).toBe("thread-1");
      expect(env).not.toHaveProperty("T3CODE_PROJECT_ID");
    }),
  );

  it.effect("keeps a spawn without a session as its caller built it", () =>
    Effect.gen(function* () {
      const env = yield* captureSpawnEnv({});
      expect(env?.T3CODE_THREAD_ID).toBe("parent-thread");
    }),
  );
});
