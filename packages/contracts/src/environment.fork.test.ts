import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ThreadEnvMode } from "./environment.ts";
import { ForkThreadEnvMode } from "./environment.fork.ts";
const decodeThreadEnvMode = Schema.decodeUnknownSync(ThreadEnvMode);
const decodeForkThreadEnvMode = Schema.decodeUnknownSync(ForkThreadEnvMode);
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
