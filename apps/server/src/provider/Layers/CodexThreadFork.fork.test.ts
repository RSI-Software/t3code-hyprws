// Fork-only: the Codex fork cursor the thread-menu fork handler writes. The V1
// runtime's lazy `thread/fork` branch went with `CodexSessionRuntime.ts`; V2
// forks natively through the adapter's `forkThread`.
import { describe, expect, it } from "@effect/vitest";

import {
  codexThreadForkOpenField,
  readCodexForkCutoffFork,
  readCodexForkSourceThreadId,
} from "./CodexThreadFork.fork.ts";

const forkCursor = {
  threadId: "parent-native-thread",
  forkFrom: { lastTurnId: "turn-9" },
};

describe("codexThreadForkOpenField", () => {
  it("reads the cutoff from a fork cursor", () => {
    expect(codexThreadForkOpenField(forkCursor)).toEqual({ forkFromLastTurnId: "turn-9" });
  });

  it("ignores a plain resume cursor", () => {
    expect(codexThreadForkOpenField({ threadId: "native-1" })).toEqual({});
  });

  it("reads the source thread id and rejects junk", () => {
    expect(readCodexForkSourceThreadId({ threadId: "native-1" })).toBe("native-1");
    expect(readCodexForkSourceThreadId({})).toBeUndefined();
    expect(readCodexForkSourceThreadId("native-1")).toBeUndefined();
  });

  it("reads a fork cursor's own cutoff and rejects junk", () => {
    expect(readCodexForkCutoffFork(forkCursor)).toBe("turn-9");
    expect(readCodexForkCutoffFork({ threadId: "native-1" })).toBeUndefined();
    expect(readCodexForkCutoffFork({ threadId: "p", forkFrom: {} })).toBeUndefined();
    expect(readCodexForkCutoffFork(null)).toBeUndefined();
  });
});
