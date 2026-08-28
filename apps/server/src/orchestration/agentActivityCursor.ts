import type { ThreadId } from "@t3tools/contracts";

/** Stable, exclusive keyset boundary for one agent's persisted activity rows. */
export interface AgentActivityPageCursor {
  readonly threadId: ThreadId;
  readonly agentId: string;
  readonly beforeSequence: number;
  readonly beforeCreatedAt: string;
  readonly beforeActivityId: string;
}

export function encodeAgentActivityPageCursor(cursor: AgentActivityPageCursor): string {
  return Buffer.from(
    JSON.stringify({
      t: cursor.threadId,
      a: cursor.agentId,
      s: cursor.beforeSequence,
      c: cursor.beforeCreatedAt,
      i: cursor.beforeActivityId,
    }),
  ).toString("base64url");
}

export function decodeAgentActivityPageCursor(encoded: string): AgentActivityPageCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.t !== "string" ||
    record.t.length === 0 ||
    typeof record.a !== "string" ||
    record.a.length === 0 ||
    typeof record.s !== "number" ||
    !Number.isSafeInteger(record.s) ||
    record.s < -1 ||
    typeof record.c !== "string" ||
    record.c.length === 0 ||
    typeof record.i !== "string" ||
    record.i.length === 0
  ) {
    return null;
  }
  return {
    threadId: record.t as ThreadId,
    agentId: record.a,
    beforeSequence: record.s,
    beforeCreatedAt: record.c,
    beforeActivityId: record.i,
  };
}
