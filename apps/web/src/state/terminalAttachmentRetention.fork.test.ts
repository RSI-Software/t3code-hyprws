import { describe, expect, it } from "vite-plus/test";
import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  nextTerminalAttachSeedState,
  terminalOutputText,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  retainedTerminalSessionFork,
  retainTerminalSession,
} from "./terminalAttachmentRetention.fork";

const session = (version: number, value: string): TerminalSessionState => {
  const byteLength = new TextEncoder().encode(value).byteLength;
  return combineTerminalSessionState(null, {
    ...EMPTY_TERMINAL_BUFFER_STATE,
    output: {
      ...EMPTY_TERMINAL_BUFFER_STATE.output,
      chunks: value.length === 0 ? [] : [{ startOffset: 0, data: value, byteLength }],
      retainedBytes: byteLength,
      nextOffset: value.length,
    },
    status: "running",
    version,
  });
};

const seed = () => combineTerminalSessionState(null, nextTerminalAttachSeedState());

describe("retained terminal sessions", () => {
  it("keeps the retained buffer while a new stream reports its uninitialized seed", () => {
    const kept = session(7, "pre-move scrollback");
    expect(retainTerminalSession(kept, seed())).toBe(kept);
    const ready = session(1, "fresh session");
    expect(retainTerminalSession(kept, ready)).toBe(ready);
    expect(retainTerminalSession(null, seed()).version).toBe(0);
  });

  it("shows an attach failure over the retained buffer", () => {
    const kept = session(4, "kept output");
    const failed = retainTerminalSession(kept, {
      ...seed(),
      error: "Exact zmux target could not be attached.",
      status: "error",
    });
    expect(terminalOutputText(failed.output)).toBe("kept output");
    expect(failed.error).toBe("Exact zmux target could not be attached.");
  });

  it("releases the live attach while hidden and keeps its last session", () => {
    const tasks: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => {};
      },
    });
    const flush = () => {
      while (tasks.length > 0) tasks.shift()!();
    };
    let liveMounts = 0;
    const output = Atom.make(session(3, "before hide"));
    const live = Atom.make((get) => {
      liveMounts += 1;
      get.addFinalizer(() => (liveMounts -= 1));
      return get(output);
    });
    const retained = retainedTerminalSessionFork(live);
    const release = registry.mount(retained);

    registry.set(retained, true);
    expect(liveMounts).toBe(1);
    expect(terminalOutputText(registry.get(retained).output)).toBe("before hide");

    registry.set(retained, false);
    flush();
    expect(liveMounts).toBe(0);
    expect(terminalOutputText(registry.get(retained).output)).toBe("before hide");

    registry.set(output, seed());
    registry.set(retained, true);
    expect(liveMounts).toBe(1);
    expect(terminalOutputText(registry.get(retained).output)).toBe("before hide");

    registry.set(output, session(1, "after show"));
    expect(terminalOutputText(registry.get(retained).output)).toBe("after show");
    release();
  });
});
