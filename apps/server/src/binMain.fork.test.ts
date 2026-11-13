import { expect, it } from "@effect/vitest";

import { runCliCommand } from "./binMain.ts";
import { heldServiceLauncherContextFork } from "./cloud/serviceLauncherContext.fork.ts";

// Packaged builds bundle bin.ts apart from binMain.ts; only binMain's graph reads the context.
it("the CLI entry takes the launcher context into the graph that reads it", async () => {
  const argv = process.argv;
  process.env.T3_SERVICE_LAUNCHER_CONTEXT = '{"protocol":4}';
  process.argv = [argv[0]!, "t3", "__speech-worker", "unknown"];
  try {
    await expect(runCliCommand()).rejects.toThrow("Unknown speech worker mode.");
    expect(process.env.T3_SERVICE_LAUNCHER_CONTEXT).toBeUndefined();
    expect(heldServiceLauncherContextFork()).toBe('{"protocol":4}');
  } finally {
    process.argv = argv;
    delete process.env.T3_SERVICE_LAUNCHER_CONTEXT;
  }
});
