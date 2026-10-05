import { expect, it } from "@effect/vitest";

import {
  heldServiceLauncherContextFork,
  takeServiceLauncherContextFork,
} from "./serviceLauncherContext.fork.ts";

it("moves the launcher context out of the environment children inherit", () => {
  const env: NodeJS.ProcessEnv = { T3_SERVICE_LAUNCHER_CONTEXT: '{"protocol":3}', PATH: "/bin" };
  takeServiceLauncherContextFork(env);
  expect(env).toEqual({ PATH: "/bin" });
  expect(heldServiceLauncherContextFork()).toBe('{"protocol":3}');
});
