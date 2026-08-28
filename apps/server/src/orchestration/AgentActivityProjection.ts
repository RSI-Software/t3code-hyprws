import {
  EventId,
  TurnId,
  type OrchestrationAgentActivity,
  type OrchestrationAgentActivitySnapshot,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { ProjectionAgentActivitySnapshot } from "./Services/ProjectionSnapshotQuery.ts";

const MAX_KIND_CHARS = 120;
const MAX_SUMMARY_CHARS = 240;
const MAX_STRING_CHARS = 8 * 1024;
const MAX_IDENTIFIER_BYTES = 512;
const FALLBACK_CREATED_AT = "1970-01-01T00:00:00.000Z";
export const AGENT_ACTIVITY_SERIALIZED_MAX_BYTES = 16 * 1024;
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

interface ProjectionState {
  truncated: boolean;
}

function redactInlineLocalPaths(value: string, state: ProjectionState): string {
  const quotedPathsRedacted = value.replace(
    /(["'`])(?:file:\/\/|~(?:[a-z0-9._-]+)?[\\/]|\\\\|\/(?!\/)|[a-z]:[\\/])[^\r\n]*?\1/giu,
    (_match, quote: string) => `${quote}[local path]${quote}`,
  );
  const redacted = quotedPathsRedacted.replace(
    /^(?:file:\/\/|~(?:[a-z0-9._-]+)?[\\/]|\\\\|\/+|[a-z]:[\\/])[^\s"'`<>|&\])},;]*|([<>|&])(?:file:\/\/|~(?:[a-z0-9._-]+)?[\\/]|\\\\|\/+|[a-z]:[\\/])[^\s"'`<>|&\])},;]*|([\s"'`([{:;,=])(?:file:\/\/|~(?:[a-z0-9._-]+)?[\\/]|\\\\|\/(?!\/)|[a-z]:[\\/])[^\s"'`<>|&\])},;]*/giu,
    (_match, shellPrefix: string | undefined, prosePrefix: string | undefined) =>
      `${shellPrefix ?? prosePrefix ?? ""}[local path]`,
  );
  if (redacted !== value) {
    state.truncated = true;
  }
  return redacted;
}

function boundedText(value: string, limit: number, state: ProjectionState): string {
  if (value.length <= limit) {
    return redactInlineLocalPaths(value, state);
  }
  state.truncated = true;
  let end = Math.max(0, limit - 1);
  if (
    end > 0 &&
    end < value.length &&
    /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(value[end] ?? "")
  ) {
    end -= 1;
  }
  return redactInlineLocalPaths(`${value.slice(0, end)}…`, state);
}

function serializedBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedIdentifier(value: string, state: ProjectionState): string {
  if (value.length <= MAX_IDENTIFIER_BYTES && serializedBytes(value) <= MAX_IDENTIFIER_BYTES) {
    return value;
  }
  state.truncated = true;
  const suffix = "…";
  const suffixBytes = serializedBytes(suffix);
  let end = Math.min(value.length, MAX_IDENTIFIER_BYTES - suffixBytes);
  while (end > 0 && serializedBytes(value.slice(0, end)) > MAX_IDENTIFIER_BYTES - suffixBytes) {
    end -= 1;
  }
  if (
    end > 0 &&
    end < value.length &&
    /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(value[end] ?? "")
  ) {
    end -= 1;
  }
  return `${value.slice(0, end)}${suffix}`;
}

function canonicalCreatedAt(value: string, state: ProjectionState): string {
  const candidate =
    value.length <= 128
      ? value
      : `${value.slice(0, 23)}${value.endsWith("Z") ? "Z" : value.slice(-6)}`;
  const parsed = DateTime.make(candidate);
  if (Option.isNone(parsed)) {
    state.truncated = true;
    return FALLBACK_CREATED_AT;
  }
  const canonical = DateTime.formatIso(parsed.value);
  if (canonical !== value) {
    state.truncated = true;
  }
  return canonical;
}

function serializeStringWithinBudget(
  value: string,
  maxBytes: number,
  state: ProjectionState,
): string | undefined {
  const redacted = boundedText(value, MAX_STRING_CHARS, state);
  const serialized = JSON.stringify(redacted);
  if (serializedBytes(serialized) <= maxBytes) {
    return serialized;
  }
  if (maxBytes < 2) {
    state.truncated = true;
    return undefined;
  }

  state.truncated = true;
  const characters = Array.from(redacted);
  let low = 0;
  let high = characters.length;
  let best = '""';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const suffix = middle < characters.length ? "…" : "";
    const candidate = JSON.stringify(`${characters.slice(0, middle).join("")}${suffix}`);
    if (serializedBytes(candidate) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function serializeValueWithinBudget(
  value: unknown,
  maxBytes: number,
  state: ProjectionState,
  depth: number,
): string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined && serializedBytes(serialized) <= maxBytes) {
      return serialized;
    }
    state.truncated = true;
    return maxBytes >= 4 ? "null" : undefined;
  }
  if (typeof value === "string") {
    return serializeStringWithinBudget(value, maxBytes, state);
  }
  if (depth >= MAX_DEPTH) {
    state.truncated = true;
    return maxBytes >= 4 ? "null" : undefined;
  }
  if (Array.isArray(value)) {
    if (maxBytes < 2) {
      state.truncated = true;
      return undefined;
    }
    if (value.length > MAX_ARRAY_ENTRIES) {
      state.truncated = true;
    }
    const entries: string[] = [];
    let usedBytes = 2;
    for (const entry of value.slice(0, MAX_ARRAY_ENTRIES)) {
      const separatorBytes = entries.length === 0 ? 0 : 1;
      const serialized = serializeValueWithinBudget(
        entry,
        maxBytes - usedBytes - separatorBytes,
        state,
        depth + 1,
      );
      if (serialized === undefined) {
        state.truncated = true;
        break;
      }
      entries.push(serialized);
      usedBytes += separatorBytes + serializedBytes(serialized);
    }
    if (entries.length < Math.min(value.length, MAX_ARRAY_ENTRIES)) {
      state.truncated = true;
    }
    return `[${entries.join(",")}]`;
  }
  if (typeof value !== "object") {
    state.truncated = true;
    return maxBytes >= 4 ? "null" : undefined;
  }
  if (maxBytes < 2) {
    state.truncated = true;
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_OBJECT_KEYS) {
    state.truncated = true;
  }
  const projected: string[] = [];
  const projectedKeys = new Set<string>();
  let usedBytes = 2;
  for (const [key, entry] of entries.slice(0, MAX_OBJECT_KEYS)) {
    if (PRIVATE_PATH_KEYS.has(key)) {
      state.truncated = true;
      continue;
    }
    const projectedKey = boundedText(key, MAX_KEY_CHARS, state);
    if (projectedKeys.has(projectedKey)) {
      state.truncated = true;
      continue;
    }
    const serializedKey = JSON.stringify(projectedKey);
    const separatorBytes = projected.length === 0 ? 0 : 1;
    const entryOverheadBytes = separatorBytes + serializedBytes(serializedKey) + 1;
    const serializedEntry = serializeValueWithinBudget(
      entry,
      maxBytes - usedBytes - entryOverheadBytes,
      state,
      depth + 1,
    );
    if (serializedEntry === undefined) {
      state.truncated = true;
      break;
    }
    projectedKeys.add(projectedKey);
    projected.push(`${serializedKey}:${serializedEntry}`);
    usedBytes += entryOverheadBytes + serializedBytes(serializedEntry);
  }
  if (projected.length < entries.filter(([key]) => !PRIVATE_PATH_KEYS.has(key)).length) {
    state.truncated = true;
  }
  return `{${projected.join(",")}}`;
}

export function projectAgentActivity(
  activity: OrchestrationThreadActivity,
): OrchestrationAgentActivity {
  const state: ProjectionState = { truncated: false };
  const id = EventId.make(boundedIdentifier(activity.id, state));
  const turnId = activity.turnId === null ? null : boundedIdentifier(activity.turnId, state);
  const boundedTurnId = turnId === null ? null : TurnId.make(turnId);
  const createdAt = canonicalCreatedAt(activity.createdAt, state);
  const kind = boundedText(activity.kind, MAX_KIND_CHARS, state);
  const summary = boundedText(activity.summary, MAX_SUMMARY_CHARS, state);
  const rowWithoutPayload = {
    id,
    tone: activity.tone,
    kind,
    summary,
    payload: null,
    turnId: boundedTurnId,
    ...(activity.sequence === undefined ? {} : { sequence: activity.sequence }),
    createdAt,
    truncated: false,
  };
  const payloadBudget = Math.max(
    4,
    AGENT_ACTIVITY_SERIALIZED_MAX_BYTES -
      serializedBytes(JSON.stringify(rowWithoutPayload)) +
      serializedBytes("null"),
  );
  const serializedPayload =
    serializeValueWithinBudget(activity.payload, payloadBudget, state, 0) ?? "null";
  return {
    ...rowWithoutPayload,
    payload: JSON.parse(serializedPayload) as unknown,
    truncated: state.truncated,
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
