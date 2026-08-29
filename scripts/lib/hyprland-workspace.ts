// @effect-diagnostics nodeBuiltinImport:off - Host-only Hyprland probes use the installed hyprctl executable.

import * as NodeChildProcess from "node:child_process";

export type WorkspaceRef = {
  readonly id: number;
  readonly name: string;
};

function readWorkspace(value: unknown, label: string): WorkspaceRef {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} returned no workspace`);
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const name = record["name"];
  if (typeof id !== "number" || !Number.isFinite(id) || typeof name !== "string" || name === "") {
    throw new Error(`${label} returned an invalid workspace`);
  }
  return { id, name };
}

export function parseHyprlandWorkspaceResponse(
  response: string,
  command: "activeworkspace" | "activewindow",
): WorkspaceRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new Error(`hyprctl ${command} returned invalid JSON`);
  }
  if (command === "activewindow") {
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("hyprctl activewindow returned no active window");
    }
    return readWorkspace((parsed as Record<string, unknown>)["workspace"], "hyprctl activewindow");
  }
  return readWorkspace(parsed, "hyprctl activeworkspace");
}

export function readHyprctlWorkspace(command: "activeworkspace" | "activewindow"): WorkspaceRef {
  const response = NodeChildProcess.execFileSync("hyprctl", ["-j", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseHyprlandWorkspaceResponse(response, command);
}
