import { SERVICE_LAUNCHER_CONTEXT_ENV } from "./serviceProtocol.ts";

let held: string | undefined;

/**
 * Moves the launcher context out of `process.env` at process start. A trial
 * child keeps a pending context for life, and every agent, provider, and test
 * it spawns would otherwise inherit an update whose `dbPath` is the live
 * database (RSI-Software/t3code-hyprws#1707).
 */
export function takeServiceLauncherContextFork(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env[SERVICE_LAUNCHER_CONTEXT_ENV];
  if (raw === undefined) return;
  held = raw;
  delete env[SERVICE_LAUNCHER_CONTEXT_ENV];
}

/** The context this process was started with, after `takeServiceLauncherContextFork`. */
export function heldServiceLauncherContextFork(): string | undefined {
  return held;
}
