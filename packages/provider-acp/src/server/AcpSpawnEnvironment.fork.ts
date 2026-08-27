import type { SpawnCommandOptions } from "@t3tools/shared/shell";

export function providerSpawnOptionsFork(
  env: NodeJS.ProcessEnv,
): Pick<SpawnCommandOptions, "env" | "extendEnv"> {
  return { env, extendEnv: false };
}
