// Fork-only (thread-ordering), retire once clients have migrated: sidebar
// groups this client kept in its UI state before each environment's server
// owned them. `threadGroups.ts` hands each environment its share to import.
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadGroupFork } from "@t3tools/contracts";

interface LegacyGroup {
  readonly id: string;
  readonly title: string;
  readonly threadIds: readonly string[];
  readonly collapsed?: boolean;
  readonly parentThreadId?: string;
}

function sanitizeLegacyGroups(value: unknown): LegacyGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate: Partial<LegacyGroup> | null): LegacyGroup[] => {
    if (candidate === null || typeof candidate !== "object") return [];
    const { id, title, threadIds, collapsed, parentThreadId } = candidate;
    if (typeof id !== "string" || !id.trim() || typeof title !== "string" || !title.trim()) {
      return [];
    }
    if (!Array.isArray(threadIds)) return [];
    return [
      {
        id: id.trim(),
        title: title.trim(),
        threadIds: threadIds.filter((key): key is string => typeof key === "string"),
        ...(collapsed === true ? { collapsed } : {}),
        ...(typeof parentThreadId === "string" ? { parentThreadId } : {}),
      },
    ];
  });
}

/** The groups a UI state saved, in either of the shapes it once used. */
export function readLegacyThreadGroupsFork(uiState: unknown): LegacyGroup[] {
  if (uiState === null || typeof uiState !== "object") return [];
  const { threadGroups, threadGroupsByProject } = uiState as {
    threadGroups?: unknown;
    threadGroupsByProject?: unknown;
  };
  return sanitizeLegacyGroups(
    threadGroups ??
      (threadGroupsByProject !== null && typeof threadGroupsByProject === "object"
        ? Object.values(threadGroupsByProject).flat()
        : undefined),
  );
}

/** One environment's share of the pending legacy groups, and what stays pending for the rest. */
export function splitLegacyThreadGroupsFork(pending: unknown, environmentId: EnvironmentId) {
  const groups = sanitizeLegacyGroups(pending);
  const inEnvironment = (key: string) => parseScopedThreadKey(key)?.environmentId === environmentId;
  const share = groups.flatMap((group) => {
    const threadIds = group.threadIds.flatMap((key) =>
      inEnvironment(key) ? [parseScopedThreadKey(key)!.threadId] : [],
    );
    if (threadIds.length < 2) return [];
    const parent = group.parentThreadId;
    const imported: ThreadGroupFork = {
      id: group.id,
      title: group.title,
      threadIds,
      parentThreadId:
        parent !== undefined && inEnvironment(parent)
          ? parseScopedThreadKey(parent)!.threadId
          : threadIds[0]!,
    };
    return [{ imported, collapsed: group.collapsed === true }];
  });
  const remaining = groups.flatMap((group) => {
    const threadIds = group.threadIds.filter((key) => !inEnvironment(key));
    return threadIds.length < 2 ? [] : [{ ...group, threadIds }];
  });
  return { share, remaining };
}
