/**
 * Minimal Hyprland IPC client.
 *
 * Hyprland still owns workspace policy. This module preserves an update
 * relaunch arrangement and applies an explicit dev-launch workspace supplied by
 * the invoking app. It never derives a workspace from monitor policy itself.
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

export type HyprlandWindowRuleGrammar = "legacy" | "lua";

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

export function formatMoveToWorkspaceRequest(
  workspace: HyprlandWorkspaceRef,
  address: string,
  grammar: HyprlandWindowRuleGrammar = "legacy",
): string {
  const target = formatWorkspaceArgument(workspace);
  if (grammar === "legacy") {
    return `/dispatch movetoworkspacesilent ${target},address:${address}`;
  }
  return `/dispatch hl.dsp.window.move({workspace=${formatLuaString(target)},follow=false,window=${formatLuaString(`address:${address}`)}})`;
}

const escapeWindowRuleRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function resolveHyprlandWindowRuleGrammar(input: {
  readonly versionPayload: string;
  readonly statusPayload: string;
}): HyprlandWindowRuleGrammar {
  try {
    const versionRecord = JSON.parse(input.versionPayload) as Record<string, unknown>;
    const statusRecord = JSON.parse(input.statusPayload) as Record<string, unknown>;
    const version = typeof versionRecord["version"] === "string" ? versionRecord["version"] : "";
    const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version);
    if (match === null) return "legacy";
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const supportsLua = major > 0 || minor >= 55;
    return supportsLua && statusRecord["configProvider"] === "lua" ? "lua" : "legacy";
  } catch {
    return "legacy";
  }
}

const formatLuaString = (value: string): string =>
  JSON.stringify(value).replaceAll("\u2028", "\\u{2028}").replaceAll("\u2029", "\\u{2029}");

const LUA_RULE_SEQUENCE_KEY = formatLuaString("t3code.rule.sequence");

function formatLuaWindowRuleHandle(title: string, kind: "workspace" | "suppression"): string {
  return `t3code.desktop-agent.${kind}.${title}`;
}

function formatLuaWindowRule(input: {
  readonly title: string;
  readonly kind: "workspace" | "suppression";
  readonly effect: string;
}): string {
  const matcher = formatWindowRuleTitleMatcher(input.title);
  if (matcher === null) return "";
  const key = formatLuaString(formatLuaWindowRuleHandle(input.title, input.kind));
  const namePrefix = formatLuaString(`t3code-desktop-agent-${input.kind}-${input.title}-`);
  const titleMatcher = formatLuaString(matcher.slice("match:title ".length));
  // One compositor-wide counter names every rule, so no name is ever reused
  // and no title leaves a counter behind.
  return `/eval local key=${key};local old=rawget(_G,key);if old then old:set_enabled(false) end;local seqkey=${LUA_RULE_SEQUENCE_KEY};local seq=(rawget(_G,seqkey) or 0)+1;rawset(_G,seqkey,seq);_G[key]=hl.window_rule({name=${namePrefix}..seq,match={title=${titleMatcher}},${input.effect}})`;
}

/** Exact map-time title matcher. Commas cannot be escaped in Hyprland rule fields. */
export function formatWindowRuleTitleMatcher(title: string): string | null {
  return title.length > 0 && !title.includes(",")
    ? `match:title ^(${escapeWindowRuleRegex(title)})$`
    : null;
}

export function formatSuppressActivationWindowRule(
  title: string,
  grammar: HyprlandWindowRuleGrammar = "legacy",
): string | null {
  const matcher = formatWindowRuleTitleMatcher(title);
  if (matcher === null) return null;
  return grammar === "legacy"
    ? `/keyword windowrule suppress_event activate activate_focus, ${matcher}`
    : formatLuaWindowRule({
        title,
        kind: "suppression",
        effect: `suppress_event=${formatLuaString("activate activate_focus")}`,
      });
}

export function formatWorkspaceWindowRule(
  workspace: HyprlandWorkspaceRef,
  title: string,
  grammar: HyprlandWindowRuleGrammar = "legacy",
): string | null {
  const matcher = formatWindowRuleTitleMatcher(title);
  if (matcher === null) return null;
  const target = `${formatWorkspaceArgument(workspace)} silent`;
  return grammar === "legacy"
    ? `/keyword windowrule workspace ${target}, ${matcher}`
    : formatLuaWindowRule({
        title,
        kind: "workspace",
        effect: `workspace=${formatLuaString(target)}`,
      });
}

/** Disables a Lua rule and drops its handle global. */
function formatClearLuaWindowRule(title: string, kind: "workspace" | "suppression"): string {
  const key = formatLuaString(formatLuaWindowRuleHandle(title, kind));
  return `/eval local key=${key};local rule=rawget(_G,key);if rule then rule:set_enabled(false);rawset(_G,key,nil) end`;
}

export function formatClearWorkspaceWindowRule(
  title: string,
  grammar: HyprlandWindowRuleGrammar = "legacy",
): string | null {
  const matcher = formatWindowRuleTitleMatcher(title);
  if (matcher === null) return null;
  if (grammar === "legacy") return `/keyword windowrule workspace unset, ${matcher}`;
  return formatClearLuaWindowRule(title, "workspace");
}

/**
 * Removes a suppression rule and its Lua globals. `null` on the legacy
 * grammar, which has no unset for `suppress_event`; a title whose rules must
 * not outlive it therefore never stages suppression there.
 */
export function formatClearSuppressionWindowRule(
  title: string,
  grammar: HyprlandWindowRuleGrammar = "legacy",
): string | null {
  if (grammar === "legacy" || formatWindowRuleTitleMatcher(title) === null) return null;
  return formatClearLuaWindowRule(title, "suppression");
}

/**
 * Pick the compositor client that belongs to a window we just opened.
 *
 * Everything this process owns shares one pid, so pid alone is ambiguous once
 * a second window exists. Claimed addresses drop out, then a single exact
 * title match is the answer. A window whose renderer retitled it before the
 * claim has one more answer: given the addresses seen before it was shown,
 * the only new client of ours that no staged title reserves. Two windows
 * mapping at once leave two new clients, and neither is guessed at.
 */
export function selectClientForWindow(input: {
  readonly clients: readonly HyprlandClient[];
  readonly pid: number;
  readonly title: string;
  readonly claimedAddresses: ReadonlySet<string>;
  /** Our client addresses before the window was shown; enables the fallback. */
  readonly knownAddresses?: ReadonlySet<string>;
  /** Titles another window claims by exact match; never a fallback answer. */
  readonly reservedTitles?: ReadonlySet<string>;
}): HyprlandClient | null {
  const candidates = input.clients.filter(
    (client) => client.pid === input.pid && !input.claimedAddresses.has(client.address),
  );
  const titled = candidates.filter((client) => client.title === input.title);
  if (titled.length === 1) return titled[0] ?? null;
  const known = input.knownAddresses;
  if (known === undefined || titled.length > 1) return null;
  const fresh = candidates.filter(
    (client) => !known.has(client.address) && !input.reservedTitles?.has(client.title),
  );
  return fresh.length === 1 ? (fresh[0] ?? null) : null;
}

class HyprlandRequestError extends Error {
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
