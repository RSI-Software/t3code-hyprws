import { executeAtomQuery, isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { withProjectFileTimeoutFork } from "./t3ProjectFileDefaults.fork";

describe("withProjectFileTimeoutFork", () => {
  // An unreachable environment leaves the file query pending forever; new-thread
  // start must fall back to the global default instead of hanging the route.
  it("settles a query that never resolves as an interrupt", async () => {
    const query = withProjectFileTimeoutFork(executeAtomQuery, 5);
    const result = await query(AtomRegistry.make(), Atom.make(Effect.never), {
      reportDefect: false,
      reportFailure: false,
    });
    expect(isAtomCommandInterrupted(result)).toBe(true);
  });
});
