// @effect-diagnostics nodeBuiltinImport:off - Host-only Hyprland probes use the installed hyprctl executable.

import { runCommandText } from "./fork-command.ts";

export type WorkspaceRef = {
  readonly id: number;
  readonly name: string;
};

export type HyprctlWorkspaceDependencies = {
  readonly run: (args: ReadonlyArray<string>) => string;
  readonly waylandDisplay: string | undefined;
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

export function selectHyprlandInstance(
  response: string,
  waylandDisplay: string | undefined,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch (error) {
    throw new Error("hyprctl instances returned invalid JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error("hyprctl instances returned an invalid list");

  const instances = parsed.filter(
    (value): value is { readonly instance: string; readonly wl_socket: string } =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>)["instance"] === "string" &&
      (value as Record<string, unknown>)["instance"] !== "" &&
      typeof (value as Record<string, unknown>)["wl_socket"] === "string",
  );
  const matching = waylandDisplay
    ? instances.filter((instance) => instance.wl_socket === waylandDisplay)
    : instances;
  if (matching.length !== 1) {
    throw new Error(
      `expected one live Hyprland instance${waylandDisplay ? ` for ${waylandDisplay}` : ""}; found ${String(matching.length)}`,
    );
  }
  return matching[0]!.instance;
}

const defaultDependencies: HyprctlWorkspaceDependencies = {
  run: (args) => runCommandText("hyprctl", args),
  waylandDisplay: process.env["WAYLAND_DISPLAY"],
};

export function readHyprctlWorkspace(
  command: "activeworkspace" | "activewindow",
  dependencies: HyprctlWorkspaceDependencies = defaultDependencies,
): WorkspaceRef {
  try {
    return parseHyprlandWorkspaceResponse(dependencies.run(["-j", command]), command);
  } catch (initialError) {
    try {
      const instance = selectHyprlandInstance(
        dependencies.run(["instances", "-j"]),
        dependencies.waylandDisplay,
      );
      return parseHyprlandWorkspaceResponse(
        dependencies.run(["-i", instance, "-j", command]),
        command,
      );
    } catch (retryError) {
      const initial = initialError instanceof Error ? initialError.message : String(initialError);
      const retry = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`${initial}; live-instance retry failed: ${retry}`, { cause: retryError });
    }
  }
}
