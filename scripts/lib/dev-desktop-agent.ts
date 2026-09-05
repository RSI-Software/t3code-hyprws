// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side dev supervision needs process groups, an allocation lock, wall-clock leases, and a loopback bind probe.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { runCommandText } from "./fork-command.ts";
import {
  readHyprctlWorkspace,
  selectHyprlandInstance,
  type WorkspaceRef,
} from "./hyprland-workspace.ts";
import { loadRepoEnv } from "./public-config.ts";

const DEBUG_PORT_BASE = 9223;
const DEBUG_PORT_SPREAD = 50;
const DEBUG_PORT_SCAN_EXTRA = 150;
const STATE_SCHEMA = "t3code.desktop-agent.v1";
const STATE_DIRECTORY_NAME = "dev-desktop-instances";
const STOP_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const DEV_RUNNER_ENV_KEYS = [
  "HOST",
  "PORT",
  "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
  "T3CODE_DEV_INSTANCE",
  "T3CODE_HOME",
  "T3CODE_HOST",
  "T3CODE_LOG_WS_EVENTS",
  "T3CODE_MODE",
  "T3CODE_NO_BROWSER",
  "T3CODE_PORT",
  "T3CODE_PORT_OFFSET",
  "T3CODE_SINGLE_ORIGIN_DEV",
  "VITE_DEV_SERVER_URL",
  "VITE_HTTP_URL",
  "VITE_WS_URL",
] as const;

export type DesktopAgentRecord = {
  readonly schema: typeof STATE_SCHEMA;
  readonly repo: string;
  readonly hash: string;
  readonly port: number;
  readonly originWorkspace: number | null;
  readonly targetWorkspace: number | null;
  readonly placementTitle: string | null;
  readonly runnerPid: number;
  readonly childPid: number | null;
  readonly startedAt: string;
};

export function withoutInheritedDevRunnerEnv(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const output = { ...environment };
  for (const key of DEV_RUNNER_ENV_KEYS) delete output[key];
  return output;
}

export function resolveAgentTargetWorkspace(origin: WorkspaceRef, offset: -1 | 1): WorkspaceRef {
  if (!Number.isSafeInteger(origin.id) || origin.id <= 0 || origin.name !== String(origin.id)) {
    throw new Error(
      `the invoking app must be on a positive numbered Hyprland workspace; received ${origin.name}`,
    );
  }
  const id = origin.id + offset;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(
      `workspace ${origin.name} has no valid ${offset < 0 ? "previous" : "next"} numbered workspace`,
    );
  }
  return { id, name: String(id) };
}

export type DesktopAgentWorkspaceSelector =
  | { readonly kind: "default" }
  | { readonly kind: "relative"; readonly offset: -1 | 1 }
  | { readonly kind: "numbered"; readonly workspace: WorkspaceRef };

export type DesktopAgentWorkspacePlacement = {
  readonly origin: WorkspaceRef | null;
  readonly target: WorkspaceRef | null;
};

export type DesktopAgentHyprlandClient = {
  readonly pid: number;
  readonly initialTitle: string;
  readonly workspace: WorkspaceRef;
  readonly mapped: boolean;
  readonly hidden: boolean;
};

export function parseDesktopAgentWorkspaceSelector(
  value: string | undefined,
): DesktopAgentWorkspaceSelector {
  const selector = value?.trim();
  if (!selector || selector === "none") return { kind: "default" };
  if (selector === "-1") return { kind: "relative", offset: -1 };
  if (selector === "+1") return { kind: "relative", offset: 1 };
  if (/^[1-9]\d*$/u.test(selector)) {
    const id = Number(selector);
    if (Number.isSafeInteger(id)) return { kind: "numbered", workspace: { id, name: selector } };
  }
  throw new Error(
    `invalid desktop agent workspace selector ${JSON.stringify(value)}; expected none, +1, -1, or a positive workspace id`,
  );
}

export function selectDesktopAgentWorkspaceSelector(
  workspaceOverride: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): DesktopAgentWorkspaceSelector {
  return parseDesktopAgentWorkspaceSelector(
    workspaceOverride ?? environment["T3CODE_DESKTOP_AGENT_WORKSPACE"],
  );
}

export function parseDesktopAgentHyprlandClients(
  payload: string,
): readonly DesktopAgentHyprlandClient[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("hyprctl clients returned invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("hyprctl clients returned an invalid list");
  return parsed.flatMap((value): DesktopAgentHyprlandClient[] => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const workspace = record["workspace"];
    if (typeof workspace !== "object" || workspace === null) return [];
    const workspaceRecord = workspace as Record<string, unknown>;
    const pid = record["pid"];
    const initialTitle = record["initialTitle"];
    const id = workspaceRecord["id"];
    const name = workspaceRecord["name"];
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof initialTitle !== "string" ||
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      typeof name !== "string"
    ) {
      return [];
    }
    return [
      {
        pid,
        initialTitle,
        workspace: { id, name },
        mapped: record["mapped"] !== false,
        hidden: record["hidden"] === true,
      },
    ];
  });
}

function readProcessParent(pid: number): number {
  try {
    const stat = NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || 0;
  } catch {
    return 0;
  }
}

export function desktopAgentAncestorPids(
  pid: number,
  readParent: (pid: number) => number = readProcessParent,
): readonly number[] {
  const ancestors: number[] = [];
  let current = readParent(pid);
  for (let hops = 0; current > 1 && hops < 64; hops += 1) {
    ancestors.push(current);
    current = readParent(current);
  }
  return ancestors;
}

export function resolveInvokingT3Workspace(input: {
  readonly projectId: string | undefined;
  readonly clients: readonly DesktopAgentHyprlandClient[];
  readonly selfPid: number;
  readonly readParent?: (pid: number) => number;
}): WorkspaceRef {
  const projectId = input.projectId?.trim() ?? "";
  const ancestors = new Set(desktopAgentAncestorPids(input.selfPid, input.readParent));
  const owned = input.clients.filter(
    (client) =>
      client.mapped && !client.hidden && client.workspace.id > 0 && ancestors.has(client.pid),
  );
  let client: DesktopAgentHyprlandClient;
  if (projectId.length > 0) {
    const matches = owned.filter((candidate) => candidate.initialTitle.trim() === projectId);
    if (matches.length > 1) {
      throw new Error(
        `relative workspace placement is ambiguous: the invoking T3 app owns ${String(matches.length)} visible windows for project ${projectId}`,
      );
    }
    if (matches.length === 1) {
      client = matches[0]!;
    } else if (owned.length === 1) {
      // A staged map-time placement title becomes Hyprland's initialTitle. The
      // sole ancestor-owned window still proves the origin without using focus.
      client = owned[0]!;
    } else if (owned.length === 0) {
      throw new Error(
        `no visible window owned by the invoking T3 app was created for project ${projectId}`,
      );
    } else {
      throw new Error(
        `relative workspace placement is ambiguous: no owned window matches project ${projectId}, and the invoking T3 app owns ${String(owned.length)} visible windows`,
      );
    }
  } else {
    if (owned.length === 0) {
      throw new Error(
        "relative workspace placement could not find a visible Hyprland window owned by the invoking process ancestry",
      );
    }
    if (owned.length > 1) {
      throw new Error(
        `relative workspace placement is ambiguous: T3CODE_PROJECT_ID is unset and the invoking process ancestry owns ${String(owned.length)} visible Hyprland windows`,
      );
    }
    client = owned[0]!;
  }
  const workspace = client.workspace;
  if (
    !Number.isSafeInteger(workspace.id) ||
    workspace.id <= 0 ||
    workspace.name !== String(workspace.id)
  ) {
    throw new Error(
      `the invoking T3 project window must be on a positive numbered Hyprland workspace; received ${workspace.name}`,
    );
  }
  return workspace;
}

function readDesktopAgentHyprlandClients(): readonly DesktopAgentHyprlandClient[] {
  try {
    return parseDesktopAgentHyprlandClients(runCommandText("hyprctl", ["-j", "clients"]));
  } catch (initialError) {
    try {
      const instance = selectHyprlandInstance(
        runCommandText("hyprctl", ["instances", "-j"]),
        process.env["WAYLAND_DISPLAY"],
      );
      return parseDesktopAgentHyprlandClients(
        runCommandText("hyprctl", ["-i", instance, "-j", "clients"]),
      );
    } catch (retryError) {
      const initial = initialError instanceof Error ? initialError.message : String(initialError);
      const retry = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`${initial}; live-instance retry failed: ${retry}`, { cause: retryError });
    }
  }
}

export type DesktopAgentWorkspaceCaptureDependencies = {
  readonly readActiveWorkspace: () => WorkspaceRef;
  readonly readClients: () => readonly DesktopAgentHyprlandClient[];
  readonly selfPid: number;
  readonly readParent: (pid: number) => number;
};

const defaultWorkspaceCaptureDependencies: DesktopAgentWorkspaceCaptureDependencies = {
  readActiveWorkspace: () => readHyprctlWorkspace("activeworkspace"),
  readClients: readDesktopAgentHyprlandClients,
  selfPid: process.pid,
  readParent: readProcessParent,
};

export function captureDesktopAgentWorkspace(
  workspaceOverride: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: DesktopAgentWorkspaceCaptureDependencies = defaultWorkspaceCaptureDependencies,
): DesktopAgentWorkspacePlacement {
  const selector = selectDesktopAgentWorkspaceSelector(workspaceOverride, environment);
  if (selector.kind === "default") return { origin: null, target: null };
  if (selector.kind === "numbered") {
    dependencies.readActiveWorkspace();
    return { origin: null, target: selector.workspace };
  }
  const origin = resolveInvokingT3Workspace({
    projectId: environment["T3CODE_PROJECT_ID"],
    clients: dependencies.readClients(),
    selfPid: dependencies.selfPid,
    readParent: dependencies.readParent,
  });
  return { origin, target: resolveAgentTargetWorkspace(origin, selector.offset) };
}

export function desktopAgentDevRunnerArgs(
  homeDir: string | undefined,
  runnerArgs: readonly string[] = [],
): readonly string[] {
  return homeDir === undefined
    ? ["run", "dev:desktop", ...runnerArgs]
    : ["run", "dev:desktop", "--home-dir", homeDir, ...runnerArgs];
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
  const root = runCommandText("git", ["rev-parse", "--show-toplevel"]).trim();
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

async function runAgentDesktop(
  dryRun: boolean,
  workspaceOverride: string | undefined,
  homeDir: string | undefined,
  runnerArgs: readonly string[],
  capturedPlacement: DesktopAgentWorkspacePlacement | undefined,
): Promise<number> {
  const repo = resolveRepo();
  const hash = desktopAgentInstanceHash(repo);
  // T3 launches agent commands with its own server and Vite environment.
  // Keep repository configuration available, but do not let the parent app's
  // ports, home, or instance selector pin this worktree's dev runner to the
  // already-running stable process.
  const repoEnv = loadRepoEnv({
    baseEnv: withoutInheritedDevRunnerEnv(process.env),
    repoRoot: repo,
  });
  const { origin, target } =
    capturedPlacement ?? captureDesktopAgentWorkspace(workspaceOverride, repoEnv);
  const directory = stateDirectory();
  const path = recordPath(hash);
  const releaseLock = await acquireAllocationLock(lockPath());
  const placementTitle = target === null ? null : `t3code-dev-agent-${hash}`;
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
      const placement =
        target === null
          ? "default"
          : origin === null
            ? `workspace:${target.name}`
            : `workspace:${origin.name}->${target.name}`;
      process.stdout.write(
        `repo=${repo} placement=${placement} debugUrl=http://127.0.0.1:${String(port)}\n`,
      );
      return 0;
    }
    record = {
      schema: STATE_SCHEMA,
      repo,
      hash,
      port,
      originWorkspace: origin?.id ?? null,
      targetWorkspace: target?.id ?? null,
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
  const placement =
    target === null
      ? "default"
      : origin === null
        ? `workspace:${target.name}`
        : `workspace:${origin.name}->${target.name}`;

  process.stdout.write(
    `[desktop-agent] placement=${placement} debugUrl=http://127.0.0.1:${String(port)} devtools=off\n`,
  );
  const childEnv = { ...repoEnv };
  delete childEnv["T3CODE_DESKTOP_AGENT_WORKSPACE"];
  delete childEnv["T3CODE_DESKTOP_AGENT_PLACEMENT_TITLE"];
  if (target !== null && placementTitle !== null) {
    childEnv["T3CODE_DESKTOP_AGENT_WORKSPACE"] = target.name;
    childEnv["T3CODE_DESKTOP_AGENT_PLACEMENT_TITLE"] = placementTitle;
  }
  const child = NodeChildProcess.spawn("vp", desktopAgentDevRunnerArgs(homeDir, runnerArgs), {
    cwd: repo,
    detached: true,
    env: {
      ...childEnv,
      T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(port),
      T3CODE_DESKTOP_DEVTOOLS: "0",
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
  command:
    | {
        readonly kind: "run";
        readonly dryRun: boolean;
        readonly workspace: string | undefined;
        readonly homeDir: string | undefined;
        readonly runnerArgs?: readonly string[];
        readonly placement?: DesktopAgentWorkspacePlacement | undefined;
      }
    | { readonly kind: "url" },
): Promise<number> {
  try {
    return command.kind === "url"
      ? printAgentUrl()
      : await runAgentDesktop(
          command.dryRun,
          command.workspace,
          command.homeDir,
          command.runnerArgs ?? [],
          command.placement,
        );
  } catch (error) {
    return printError(error);
  }
}
