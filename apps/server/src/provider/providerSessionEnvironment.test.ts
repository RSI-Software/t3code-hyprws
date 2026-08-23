import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withProviderSessionIdentity } from "./providerSessionEnvironment.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

describe("withProviderSessionIdentity", () => {
  it("adds the session identity on top of the base environment", () => {
    const env = withProviderSessionIdentity({ PATH: "/bin" }, { threadId, projectId });
    expect(env).toEqual({
      PATH: "/bin",
      T3CODE_PROJECT_ID: "project-1",
      T3CODE_THREAD_ID: "thread-1",
    });
  });

  it("drops inherited ids the session does not know", () => {
    const env = withProviderSessionIdentity(
      {
        PATH: "/bin",
        T3CODE_PROJECT_ID: "stale-project",
        T3CODE_THREAD_ID: "stale-thread",
      },
      { threadId },
    );
    expect(env).toEqual({ PATH: "/bin", T3CODE_THREAD_ID: "thread-1" });
  });

  it("does not mutate the base environment", () => {
    const base = { PATH: "/bin" };
    withProviderSessionIdentity(base, { threadId });
    expect(base).toEqual({ PATH: "/bin" });
  });

  it("falls back to the server process environment", () => {
    const env = withProviderSessionIdentity(undefined, { threadId });
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.T3CODE_THREAD_ID).toBe("thread-1");
  });
});
