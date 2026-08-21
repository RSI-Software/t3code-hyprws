/**
 * Minimal Hyprland IPC client.
 *
 * The fork does not place windows -- Hyprland does. This module exists only so
 * an update relaunch can put a window back on the workspace the user had
 * already put it on. Read the workspace of a live window, and move a restored
 * window back silently. Nothing here decides where a new window belongs.
 *
 * Speaks the compositor's socket directly instead of shelling out to
 * `hyprctl`, because that is all `hyprctl` does and a child process per query
 * is not worth it during shutdown.
 */
import * as NodeNet from "node:net";

export type HyprlandWorkspaceRef = {
  readonly id: number;
  readonly name: string;
};

export type HyprlandClient = {
  readonly address: string;
  readonly pid: number;
  readonly title: string;
  readonly workspace: HyprlandWorkspaceRef;
};

export type HyprlandSocketEnvironment = {
  readonly instanceSignature: string | undefined;
  readonly runtimeDirectory: string | undefined;
};

export function readHyprlandSocketEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): HyprlandSocketEnvironment {
  return {
    instanceSignature: env["HYPRLAND_INSTANCE_SIGNATURE"],
    runtimeDirectory: env["XDG_RUNTIME_DIR"],
  };
}

/**
 * Hyprland moved its socket under `$XDG_RUNTIME_DIR` in 0.40; older builds
 * still keep it in `/tmp`. Try both so the fork does not pin a compositor
 * version.
 */
export function hyprlandSocketCandidates(
  environment: HyprlandSocketEnvironment,
): readonly string[] {
  const signature = environment.instanceSignature?.trim() ?? "";
  if (signature.length === 0) return [];
  const runtimeDirectory = environment.runtimeDirectory?.trim() ?? "";
  const candidates =
    runtimeDirectory.length === 0 ? [] : [`${runtimeDirectory}/hypr/${signature}/.socket.sock`];
  return [...candidates, `/tmp/hypr/${signature}/.socket.sock`];
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Tolerant on purpose: an unknown field in a newer Hyprland must not throw. */
export function parseHyprlandClients(payload: string): readonly HyprlandClient[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const clients: HyprlandClient[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const address = readString(record["address"]);
    const pid = readNumber(record["pid"]);
    if (address === null || pid === null) continue;
    const workspace = record["workspace"];
    if (typeof workspace !== "object" || workspace === null) continue;
    const workspaceRecord = workspace as Record<string, unknown>;
    const workspaceId = readNumber(workspaceRecord["id"]);
    const workspaceName = readString(workspaceRecord["name"]);
    if (workspaceId === null || workspaceName === null) continue;
    clients.push({
      address,
      pid,
      title: typeof record["title"] === "string" ? record["title"] : "",
      workspace: { id: workspaceId, name: workspaceName },
    });
  }
  return clients;
}

/**
 * Workspace selector for a dispatch. Numbered workspaces address by id;
 * special and named ones address by name, which is how `hyprctl` spells them.
 */
export function formatWorkspaceArgument(workspace: HyprlandWorkspaceRef): string {
  if (workspace.name.startsWith("special:")) return workspace.name;
  if (workspace.id > 0 && workspace.name === String(workspace.id)) return String(workspace.id);
  return workspace.name.length > 0 ? `name:${workspace.name}` : String(workspace.id);
}

/**
 * Pick the compositor client that belongs to a window we just opened.
 *
 * Everything this process owns shares one pid, so pid alone is ambiguous once
 * a second window exists. Claimed addresses drop out first, then an exact
 * title match wins; a lone remaining candidate is taken as the answer. Any
 * other shape is left unmatched rather than guessed at.
 */
export function selectClientForWindow(input: {
  readonly clients: readonly HyprlandClient[];
  readonly pid: number;
  readonly title: string;
  readonly claimedAddresses: ReadonlySet<string>;
}): HyprlandClient | null {
  const candidates = input.clients.filter(
    (client) => client.pid === input.pid && !input.claimedAddresses.has(client.address),
  );
  if (candidates.length === 0) return null;
  const titled = candidates.filter((client) => client.title === input.title);
  if (titled.length === 1) return titled[0] ?? null;
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export class HyprlandRequestError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Hyprland IPC request failed: ${reason}`);
    this.name = "HyprlandRequestError";
    this.reason = reason;
  }
}

const REQUEST_TIMEOUT_MS = 1_500;

function requestOnSocket(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = NodeNet.connect(socketPath);
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      run();
    };
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
      finish(() => reject(new HyprlandRequestError("timed out")));
    });
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", (error: Error) => {
      finish(() => reject(new HyprlandRequestError(error.message)));
    });
    socket.on("end", () => {
      finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    socket.on("close", () => {
      finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

/** Sends one IPC command, trying each known socket location in turn. */
export async function requestHyprland(
  environment: HyprlandSocketEnvironment,
  payload: string,
): Promise<string> {
  const candidates = hyprlandSocketCandidates(environment);
  if (candidates.length === 0) {
    throw new HyprlandRequestError("no HYPRLAND_INSTANCE_SIGNATURE in the environment");
  }
  let lastError: unknown = null;
  for (const socketPath of candidates) {
    try {
      return await requestOnSocket(socketPath, payload);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new HyprlandRequestError("unreachable");
}
