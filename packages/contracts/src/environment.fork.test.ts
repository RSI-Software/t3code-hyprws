import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ExecutionEnvironmentDescriptor, ThreadEnvMode } from "./environment.ts";
import { ForkThreadEnvMode } from "./environment.fork.ts";
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeThreadEnvMode = Schema.decodeUnknownSync(ThreadEnvMode);
const decodeForkThreadEnvMode = Schema.decodeUnknownSync(ForkThreadEnvMode);
const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;
describe("ExecutionEnvironmentDescriptor", () => {
  it("treats a missing GitHub Issues capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.githubIssues).toBeUndefined();
  });
  it("preserves an advertised GitHub Issues capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, githubIssues: true },
      }).capabilities.githubIssues,
    ).toBe(true);
  });
});
describe("ThreadEnvMode (the wire schema)", () => {
  it("accepts only the modes every released client validates against", () => {
    expect(decodeThreadEnvMode("local")).toBe("local");
    expect(decodeThreadEnvMode("worktree")).toBe("worktree");
    expect(() => decodeThreadEnvMode("worktrunk")).toThrow();
  });
});
describe("ForkThreadEnvMode", () => {
  it("matches the stored mode literals, including the fork-only mode", () => {
    expect(decodeForkThreadEnvMode("local")).toBe("local");
    expect(decodeForkThreadEnvMode("worktree")).toBe("worktree");
    expect(decodeForkThreadEnvMode("worktrunk")).toBe("worktrunk");
  });
});
