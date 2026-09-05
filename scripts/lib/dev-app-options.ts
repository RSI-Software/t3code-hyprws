import { parseArgs, UsageError } from "./fork-cli.ts";

export { UsageError } from "./fork-cli.ts";

export type DevAppSurface = "external" | "desktop" | "preview";

export interface DevAppOptions {
  readonly surface: DevAppSurface;
  readonly workspace?: string;
  readonly host?: string;
  readonly port?: number;
  readonly dryRun: boolean;
}

function parseWorkspace(value: string): string {
  const workspace = value.trim();
  if (workspace === "none" || workspace === "+1" || workspace === "-1") return workspace;
  if (/^[1-9]\d*$/u.test(workspace) && Number.isSafeInteger(Number(workspace))) return workspace;
  throw new UsageError(
    `invalid --workspace value ${JSON.stringify(value)}; expected none, +1, -1, or a positive workspace id`,
  );
}

function parseHost(value: string): string {
  const host = value.trim();
  if (host.length === 0) throw new UsageError("--host requires a non-empty value");
  return host;
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new UsageError(`invalid --port value ${JSON.stringify(value)}; expected 1..65535`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError(`invalid --port value ${JSON.stringify(value)}; expected 1..65535`);
  }
  return port;
}

export function parseDevAppOptions(argv: ReadonlyArray<string>): DevAppOptions {
  const parsed = parseArgs(argv, {
    values: ["--workspace", "--host", "--port"],
    flags: ["--external", "--desktop", "--preview", "--dry-run"],
  });
  const selectedSurfaces = (["--external", "--desktop", "--preview"] as const).filter((flag) =>
    parsed.flags.has(flag),
  );
  if (selectedSurfaces.length > 1) {
    throw new UsageError("--external, --desktop, and --preview are mutually exclusive");
  }

  const surface: DevAppSurface = parsed.flags.has("--desktop")
    ? "desktop"
    : parsed.flags.has("--preview")
      ? "preview"
      : "external";
  const workspaceValue = parsed.values.get("--workspace");
  if (workspaceValue !== undefined && surface !== "desktop") {
    throw new UsageError("--workspace is available only with --desktop");
  }

  const hostValue = parsed.values.get("--host");
  const portValue = parsed.values.get("--port");
  return {
    surface,
    ...(workspaceValue === undefined ? {} : { workspace: parseWorkspace(workspaceValue) }),
    ...(hostValue === undefined ? {} : { host: parseHost(hostValue) }),
    ...(portValue === undefined ? {} : { port: parsePort(portValue) }),
    dryRun: parsed.flags.has("--dry-run"),
  };
}
