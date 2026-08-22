import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { projectWindowIdentity, type WindowIdentity } from "./WindowIdentity.ts";

const PROJECT_FLAG = "--project";
const PROJECT_FLAG_PREFIX = `${PROJECT_FLAG}=`;
const DESKTOP_PROTOCOLS = new Set(["t3code:", "t3code-dev:"]);

function decodePathPart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded.length === 0 ? null : decoded;
  } catch {
    return null;
  }
}

function identityFromParts(environmentId: string, projectId: string): WindowIdentity | null {
  const normalizedEnvironmentId = decodePathPart(environmentId);
  const normalizedProjectId = decodePathPart(projectId);
  return normalizedEnvironmentId === null || normalizedProjectId === null
    ? null
    : projectWindowIdentity(
        EnvironmentId.make(normalizedEnvironmentId),
        ProjectId.make(normalizedProjectId),
      );
}

export function resolveProjectWindowIntent(value: string): WindowIdentity | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;

  if (normalized.startsWith("/project/")) {
    const [, family, environmentId, projectId] = normalized.split("/");
    return family === "project" && environmentId !== undefined && projectId !== undefined
      ? identityFromParts(environmentId, projectId)
      : null;
  }

  try {
    const url = new URL(normalized);
    if (!DESKTOP_PROTOCOLS.has(url.protocol) || url.hostname !== "app") return null;
    const [, family, environmentId, projectId] = url.pathname.split("/");
    return family === "project" && environmentId !== undefined && projectId !== undefined
      ? identityFromParts(environmentId, projectId)
      : null;
  } catch {
    const separator = normalized.indexOf("/");
    return separator <= 0
      ? null
      : identityFromParts(normalized.slice(0, separator), normalized.slice(separator + 1));
  }
}

export function resolveWindowIdentityFromArguments(argv: readonly string[]): WindowIdentity | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]?.trim() ?? "";
    if (argument === PROJECT_FLAG) {
      const environmentId = argv[index + 1];
      const projectId = argv[index + 2];
      if (environmentId !== undefined && projectId !== undefined) {
        const identity = identityFromParts(environmentId, projectId);
        if (identity !== null) return identity;
      }
      continue;
    }
    const candidate = argument.startsWith(PROJECT_FLAG_PREFIX)
      ? argument.slice(PROJECT_FLAG_PREFIX.length)
      : argument.startsWith("/project/") ||
          argument.startsWith("t3code://") ||
          argument.startsWith("t3code-dev://")
        ? argument
        : "";
    const identity = resolveProjectWindowIntent(candidate);
    if (identity !== null) return identity;
  }
  return null;
}
