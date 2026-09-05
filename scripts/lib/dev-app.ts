// @effect-diagnostics nodeBuiltinImport:off - Thin fork entrypoint delegates runtime ownership to the existing runners.
// @effect-diagnostics globalFetch:off - The wrapper probes Vite before handing its existing pairing URL to a browser.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  buildDevAppRunnerArgs,
  loadDevAppEnvironment,
  resolveDevAppCheckoutRoot,
} from "./dev-app-env.ts";
import type { DevAppOptions } from "./dev-app-options.ts";
import { registerDevAppProject } from "./dev-app-project.ts";
import { captureDesktopAgentWorkspace, runDesktopAgentCommand } from "./dev-desktop-agent.ts";

export function devAppRunnerOptions(options: DevAppOptions): string[] {
  const args = ["--auto-bootstrap-project-from-cwd=false"];
  if (options.port !== undefined) args.push("--port", String(options.port));
  if (options.host !== undefined) args.push("--host", options.host);
  if (options.surface === "external") args.push("--browser");
  if (options.dryRun) args.push("--dry-run");
  return args;
}

/** Only normal startup pairing output can supply the preview credential. */
export function startupPairingUrl(line: string): string | undefined {
  const match =
    /pairingUrl["']?\s*[:=]\s*["']?(http:\/\/(?:localhost|127\.0\.0\.1):\d+\/pair#token=[A-Za-z0-9_.~-]+)/.exec(
      NodeUtil.stripVTControlCharacters(line),
    );
  return match?.[1];
}

/** A useful refusal for an existing run; general atomic ownership belongs to the server. */
export function assertDevAppHomeStopped(home: string): void {
  const path = NodePath.join(home, "userdata", "server-runtime.json");
  let record: { pid?: unknown };
  try {
    record = JSON.parse(NodeFS.readFileSync(path, "utf8")) as { pid?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Cannot inspect dev runtime at ${path}; check its existing terminal.`, {
      cause: error,
    });
  }
  if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw new Error(`Invalid dev runtime record at ${path}; check its existing terminal.`);
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  throw new Error(
    `A dev backend already uses ${home}. Stop its terminal before restarting or switching clients.`,
  );
}

async function waitForPreview(url: string, signal: AbortSignal): Promise<void> {
  const origin = new URL(url).origin;
  const deadline = performance.now() + 60_000;
  while (!signal.aborted && performance.now() < deadline) {
    try {
      const response = await fetch(origin, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    await NodeTimersPromises.setTimeout(200, undefined, { signal });
  }
  throw new Error(`Dev web did not become ready at ${origin}. Check the runner output.`);
}

async function runWeb(
  checkoutRoot: string,
  options: DevAppOptions,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const args = buildDevAppRunnerArgs({
    checkoutRoot,
    mode: "dev",
    runnerArgs: devAppRunnerOptions(options),
  });
  const preview = options.surface === "preview" && !options.dryRun;
  const platform = Effect.runSync(HostProcessPlatform);
  const child = NodeChildProcess.spawn(process.execPath, args, {
    cwd: checkoutRoot,
    env,
    detached: platform !== "win32",
    stdio: preview ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  const controller = new AbortController();
  let requestedSignal: NodeJS.Signals | undefined;
  let handoffFailed = false;
  let handoff: Promise<void> | undefined;
  const forward = (signal: NodeJS.Signals) => {
    requestedSignal = signal;
    if (child.pid === undefined) return;
    try {
      if (platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  const onHup = () => forward("SIGHUP");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);

  const capture = (output: NodeJS.WriteStream) => {
    let pending = "";
    return (chunk: string) => {
      output.write(chunk);
      if (handoff !== undefined) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = (lines.pop() ?? "").slice(-16_384);
      for (const line of lines) {
        const url = startupPairingUrl(line);
        if (url === undefined) continue;
        handoff = waitForPreview(url, controller.signal)
          .then(() => {
            process.stdout.write(`[dev-app] previewUrl=${url}\n`);
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            handoffFailed = true;
            process.stderr.write(
              `[dev-app] ${error instanceof Error ? error.message : String(error)}\n`,
            );
            forward("SIGTERM");
          });
        break;
      }
    };
  };
  child.stdout?.setEncoding("utf8").on("data", capture(process.stdout));
  child.stderr?.setEncoding("utf8").on("data", capture(process.stderr));
  try {
    const result = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (handoffFailed) return 1;
    if (requestedSignal === "SIGINT") return 130;
    return requestedSignal === undefined ? result : 1;
  } finally {
    controller.abort();
    await handoff;
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
  }
}

export async function runDevApp(options: DevAppOptions): Promise<number> {
  const checkoutRoot = resolveDevAppCheckoutRoot(process.cwd());
  const home = NodePath.join(checkoutRoot, ".t3");
  const env = loadDevAppEnvironment({ checkoutRoot });
  const desktopPlacement =
    options.surface === "desktop"
      ? captureDesktopAgentWorkspace(options.workspace, env)
      : undefined;
  if (!options.dryRun) {
    assertDevAppHomeStopped(home);
    registerDevAppProject({ checkoutRoot, baseDir: home });
  }
  process.stdout.write(
    `[dev-app] surface=${options.surface} checkout=${checkoutRoot} home=${home}\n`,
  );
  if (options.surface === "desktop") {
    return runDesktopAgentCommand({
      kind: "run",
      dryRun: options.dryRun,
      workspace: options.workspace,
      homeDir: home,
      placement: desktopPlacement,
      runnerArgs: devAppRunnerOptions(options).filter((arg) => arg !== "--dry-run"),
    });
  }
  return runWeb(checkoutRoot, options, env);
}
