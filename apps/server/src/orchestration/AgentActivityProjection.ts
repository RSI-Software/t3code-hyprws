import type {
  OrchestrationAgentActivity,
  OrchestrationAgentActivitySnapshot,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import type { ProjectionAgentActivitySnapshot } from "./Services/ProjectionSnapshotQuery.ts";

const MAX_KIND_CHARS = 120;
const MAX_SUMMARY_CHARS = 240;
const MAX_STRING_CHARS = 8 * 1024;
const MAX_PAYLOAD_CHARS = 16 * 1024;
const MAX_ARRAY_ENTRIES = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_KEY_CHARS = 80;
const MAX_DEPTH = 6;

const PRIVATE_PATH_KEYS = new Set([
  "scriptPath",
  "transcriptDir",
  "outputFile",
  "workspaceRoot",
  "worktreePath",
  "cwd",
  "absolutePath",
]);

interface ProjectionBudget {
  remainingChars: number;
  truncated: boolean;
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^(?:file:\/\/|~[\\/]|\\\\|\/(?!\/)|[a-z]:[\\/])/iu.test(value.trim());
}

function redactInlineLocalPaths(value: string, budget: ProjectionBudget): string {
  const redacted = value.replace(
    /(^|[\s"'`([{:;,=])(?:file:\/\/|~[\\/]|\\\\|\/(?!\/)|[a-z]:[\\/])[^\s"'`<>\])},;]*/giu,
    (match, prefix: string) => `${prefix}[local path]`,
  );
  if (redacted !== value) {
    budget.truncated = true;
  }
  return redacted;
}

function boundedString(value: string, limit: number, budget: ProjectionBudget): string {
  const redacted = redactInlineLocalPaths(value, budget);
  const allowed = Math.max(0, Math.min(limit, budget.remainingChars));
  if (redacted.length <= allowed) {
    budget.remainingChars -= redacted.length;
    return redacted;
  }
  budget.truncated = true;
  budget.remainingChars = 0;
  if (allowed <= 1) {
    return "…".slice(0, allowed);
  }
  return `${redacted.slice(0, allowed - 1)}…`;
}

function sanitizeValue(value: unknown, budget: ProjectionBudget, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return boundedString(value, MAX_STRING_CHARS, budget);
  }
  if (depth >= MAX_DEPTH || budget.remainingChars <= 0) {
    budget.truncated = true;
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ENTRIES) {
      budget.truncated = true;
    }
    return value
      .slice(0, MAX_ARRAY_ENTRIES)
      .map((entry) => sanitizeValue(entry, budget, depth + 1));
  }
  if (typeof value !== "object") {
    budget.truncated = true;
    return null;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_OBJECT_KEYS) {
    budget.truncated = true;
  }
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, MAX_OBJECT_KEYS)) {
    if (PRIVATE_PATH_KEYS.has(key) || key.length > MAX_KEY_CHARS) {
      budget.truncated = true;
      continue;
    }
    if (typeof entry === "string" && isAbsoluteLocalPath(entry)) {
      budget.truncated = true;
      continue;
    }
    budget.remainingChars -= key.length;
    if (budget.remainingChars <= 0) {
      budget.truncated = true;
      break;
    }
    projected[key] = sanitizeValue(entry, budget, depth + 1);
  }
  return projected;
}

export function projectAgentActivity(
  activity: OrchestrationThreadActivity,
): OrchestrationAgentActivity {
  const budget: ProjectionBudget = { remainingChars: MAX_PAYLOAD_CHARS, truncated: false };
  const kind = boundedString(activity.kind, MAX_KIND_CHARS, budget);
  const summary = boundedString(activity.summary, MAX_SUMMARY_CHARS, budget);
  const payload = sanitizeValue(activity.payload, budget, 0);
  return {
    id: activity.id,
    tone: activity.tone,
    kind,
    summary,
    payload,
    turnId: activity.turnId,
    ...(activity.sequence === undefined ? {} : { sequence: activity.sequence }),
    createdAt: activity.createdAt,
    truncated: budget.truncated,
  };
}

export function projectAgentActivitySnapshot(
  snapshot: ProjectionAgentActivitySnapshot,
): OrchestrationAgentActivitySnapshot {
  return {
    agentId: snapshot.agentId,
    activities: snapshot.activities.map(projectAgentActivity),
    page: snapshot.page,
  };
}
