import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./acp/AcpSessionRuntime.ts";
import {
  providerSessionIdentity,
  providerSessionProjectId,
  withoutProviderSessionIdentity,
  withSessionIdentityWhenKnown,
} from "./providerSessionEnvironment.ts";

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
