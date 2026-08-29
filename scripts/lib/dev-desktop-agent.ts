// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side dev supervision needs process groups, an allocation lock, wall-clock leases, and a loopback bind probe.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { readHyprctlWorkspace, type WorkspaceRef } from "./hyprland-workspace.ts";

const DEBUG_PORT_BASE = 9223;
const DEBUG_PORT_SPREAD = 50;
const DEBUG_PORT_SCAN_EXTRA = 150;
const STATE_SCHEMA = "t3code.desktop-agent.v1";
const STATE_DIRECTORY_NAME = "dev-desktop-instances";
const STOP_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

export type DesktopAgentRecord = {
  readonly schema: typeof STATE_SCHEMA;
  readonly repo: string;
  readonly hash: string;
  readonly port: number;
  readonly originWorkspace: number;
  readonly targetWorkspace: number;
  readonly placementTitle: string;
  readonly runnerPid: number;
  readonly childPid: number | null;
  readonly startedAt: string;
};

export function resolveAgentTargetWorkspace(origin: WorkspaceRef): WorkspaceRef {
  if (origin.id <= 1 || origin.name !== String(origin.id)) {
    throw new Error(
      `the invoking app must be on a numbered Hyprland workspace above 1; received ${origin.name}`,
    );
  }
  const id = origin.id - 1;
  return { id, name: String(id) };
}

export function desktopAgentInstanceHash(repo: string): string {
  return NodeCrypto.createHash("sha256").update(repo).digest("hex").slice(0, 12);
}

export function desktopAgentPortCandidate(
  hash: string,
  base = DEBUG_PORT_BASE,
  spread = DEBUG_PORT_SPREAD,
): number {
  return base + (Number.parseInt(hash.slice(0, 6), 16) % spread);
}

export async function allocateDesktopAgentPort(input: {
  readonly hash: string;
  readonly claimedPorts: ReadonlySet<number>;
  readonly isBindable: (port: number) => Promise<boolean>;
  readonly base?: number;
  readonly spread?: number;
  readonly scanExtra?: number;
}): Promise<number> {
  const base = input.base ?? DEBUG_PORT_BASE;
  const spread = input.spread ?? DEBUG_PORT_SPREAD;
  const start = desktopAgentPortCandidate(input.hash, base, spread);
  const end = base + spread + (input.scanExtra ?? DEBUG_PORT_SCAN_EXTRA);
  for (let port = start; port < end; port += 1) {
    if (input.claimedPorts.has(port)) continue;
    if (await input.isBindable(port)) return port;
  }
  throw new Error(`no free desktop debugging port found from ${start} (base ${base})`);
}

function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["XDG_STATE_HOME"]?.trim();
  return NodePath.join(configured || NodePath.join(NodeOS.homedir(), ".local", "state"), "t3code");
}

function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return NodePath.join(stateRoot(env), STATE_DIRECTORY_NAME);
}

function recordPath(hash: string, env: NodeJS.ProcessEnv = process.env): string {
  return NodePath.join(stateDirectory(env), `${hash}.json`);
}

function lockPath(env: NodeJS.ProcessEnv = process.env): string {
  return NodePath.join(stateRoot(env), `${STATE_DIRECTORY_NAME}.lock`);
}

function resolveRepo(): string {
  const root = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return NodeFS.realpathSync(root);
}

function readRecord(path: string): DesktopAgentRecord | null {
  try {
    const value = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Partial<DesktopAgentRecord>;
    if (
      value.schema !== STATE_SCHEMA ||
      typeof value.repo !== "string" ||
      typeof value.hash !== "string" ||
      !Number.isInteger(value.port) ||
      !Number.isInteger(value.runnerPid)
    ) {
      return null;
    }
    return value as DesktopAgentRecord;
  } catch {
    return null;
  }
}

function writeRecord(path: string, record: DesktopAgentRecord): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
  NodeFS.renameSync(temporaryPath, path);
}

function removeOwnedRecord(path: string, runnerPid: number): void {
  const current = readRecord(path);
  if (current?.runnerPid === runnerPid) NodeFS.rmSync(path, { force: true });
}

function pidAlive(pid: number | null): boolean {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processCwd(pid: number): string | null {
  try {
    return NodeFS.realpathSync(`/proc/${String(pid)}/cwd`);
  } catch {
    return null;
  }
}

function processCommand(pid: number): string {
  try {
    return NodeFS.readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function isOwnedRunner(record: DesktopAgentRecord): boolean {
  return (
    pidAlive(record.runnerPid) &&
    processCwd(record.runnerPid) === record.repo &&
    processCommand(record.runnerPid).includes("scripts/dev-desktop-agent.ts")
  );
}

function isOwnedChild(record: DesktopAgentRecord): boolean {
  return (
    record.childPid !== null &&
    pidAlive(record.childPid) &&
    processCwd(record.childPid) === record.repo
  );
}

function recordIsLive(record: DesktopAgentRecord): boolean {
  return isOwnedRunner(record) || isOwnedChild(record);
}

async function acquireAllocationLock(path: string): Promise<() => void> {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const descriptor = NodeFS.openSync(path, "wx");
      NodeFS.writeFileSync(descriptor, `${String(process.pid)}\n`);
      NodeFS.closeSync(descriptor);
      return () => {
        try {
          const owner = NodeFS.readFileSync(path, "utf8").trim();
          if (owner === String(process.pid)) NodeFS.rmSync(path, { force: true });
        } catch {
          // A missing lock is already released.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = 0;
      try {
        owner = Number(NodeFS.readFileSync(path, "utf8").trim());
      } catch {
        // An incomplete owner is stale.
      }
      if (!pidAlive(owner)) {
        NodeFS.rmSync(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for allocation lock ${path}`, { cause: error });
      }
      await NodeTimersPromises.setTimeout(50);
    }
  }
}

async function stopOwnedRecord(record: DesktopAgentRecord): Promise<void> {
  if (!recordIsLive(record)) return;
  if (isOwnedRunner(record)) {
    process.kill(record.runnerPid, "SIGTERM");
  } else if (record.childPid !== null && isOwnedChild(record)) {
    process.kill(-record.childPid, "SIGTERM");
  } else {
    throw new Error(`refusing to stop unverified desktop runner pid ${String(record.runnerPid)}`);
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (recordIsLive(record) && Date.now() < deadline) {
    await NodeTimersPromises.setTimeout(100);
  }

  if (recordIsLive(record)) {
    // Restart is explicit. Escalate only against the exact registered process
    // group and runner after re-validating their cwd and command ownership.
    if (record.childPid !== null && isOwnedChild(record)) process.kill(-record.childPid, "SIGKILL");
    if (isOwnedRunner(record)) process.kill(record.runnerPid, "SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (recordIsLive(record) && Date.now() < killDeadline) {
      await NodeTimersPromises.setTimeout(50);
    }
    if (recordIsLive(record)) {
      throw new Error(`desktop runner pid ${String(record.runnerPid)} did not stop`);
    }
  }

  // Descendant Electron processes can release CDP just after their registered
  // group leaders exit. Give the stable candidate a bounded grace period
  // before the allocator scans onward.
  const portDeadline = Math.min(deadline, Date.now() + 2_000);
  while (!(await portBindable(record.port)) && Date.now() < portDeadline) {
    await NodeTimersPromises.setTimeout(50);
  }
}

function readLiveClaimedPorts(directory: string, ownHash: string): Set<number> {
  const ports = new Set<number>();
  let names: string[];
  try {
    names = NodeFS.readdirSync(directory);
  } catch {
    return ports;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name === `${ownHash}.json`) continue;
    const record = readRecord(NodePath.join(directory, name));
    if (record !== null && recordIsLive(record)) ports.add(record.port);
  }
  return ports;
}

function portBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function printError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

async function runAgentDesktop(dryRun: boolean): Promise<number> {
  const repo = resolveRepo();
  const hash = desktopAgentInstanceHash(repo);
  const origin = readHyprctlWorkspace("activewindow");
  const target = resolveAgentTargetWorkspace(origin);
  const directory = stateDirectory();
  const path = recordPath(hash);
  const releaseLock = await acquireAllocationLock(lockPath());
  const placementTitle = `t3code-dev-agent-${hash}`;
  let record: DesktopAgentRecord | null = null;
  try {
    const previous = readRecord(path);
    if (!dryRun && previous !== null) await stopOwnedRecord(previous);
    const claimedPorts = readLiveClaimedPorts(directory, hash);
    const port =
      dryRun && previous !== null && recordIsLive(previous)
        ? previous.port
        : await allocateDesktopAgentPort({ hash, claimedPorts, isBindable: portBindable });
    if (dryRun) {
      process.stdout.write(
        `repo=${repo} origin=${origin.name} target=${target.name} debugUrl=http://127.0.0.1:${String(port)}\n`,
      );
      return 0;
    }
    record = {
      schema: STATE_SCHEMA,
      repo,
      hash,
      port,
      originWorkspace: origin.id,
      targetWorkspace: target.id,
      placementTitle,
      runnerPid: process.pid,
      childPid: null,
      startedAt: new Date().toISOString(),
    };
    // Claim the selected port before releasing the global allocator lock.
    writeRecord(path, record);
  } finally {
    releaseLock();
  }

  if (record === null) throw new Error("desktop agent state was not initialized");
  const port = record.port;

  process.stdout.write(
    `[desktop-agent] workspace=${origin.name}->${target.name} debugUrl=http://127.0.0.1:${String(port)} devtools=off\n`,
  );
  const child = NodeChildProcess.spawn("vp", ["run", "dev:desktop"], {
    cwd: repo,
    detached: true,
    env: {
      ...process.env,
      T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(port),
      T3CODE_DESKTOP_DEVTOOLS: "0",
      T3CODE_DESKTOP_AGENT_WORKSPACE: target.name,
      T3CODE_DESKTOP_AGENT_PLACEMENT_TITLE: placementTitle,
    },
    stdio: "inherit",
  });
  record = { ...record, childPid: child.pid ?? null };
  writeRecord(path, record);

  let requestedSignal: NodeJS.Signals | null = null;
  const forwardSignal = (signal: NodeJS.Signals) => {
    requestedSignal = signal;
    if (child.pid !== undefined && pidAlive(child.pid)) process.kill(-child.pid, signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  const onSighup = () => forwardSignal("SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    if (requestedSignal === "SIGINT") return 130;
    if (requestedSignal !== null) return 1;
    return result.signal === null ? (result.code ?? 1) : 1;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    removeOwnedRecord(path, process.pid);
  }
}

function printAgentUrl(): number {
  const repo = resolveRepo();
  const hash = desktopAgentInstanceHash(repo);
  const record = readRecord(recordPath(hash));
  if (record === null || !recordIsLive(record)) {
    throw new Error(`no live agent desktop instance for ${repo}`);
  }
  process.stdout.write(`http://127.0.0.1:${String(record.port)}\n`);
  return 0;
}

export async function runDesktopAgentCommand(
  command: { readonly kind: "run"; readonly dryRun: boolean } | { readonly kind: "url" },
): Promise<number> {
  try {
    return command.kind === "url" ? printAgentUrl() : await runAgentDesktop(command.dryRun);
  } catch (error) {
    return printError(error);
  }
}
