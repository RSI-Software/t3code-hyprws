import type { ScopedThreadRef } from "@t3tools/contracts";

import type { GitHubIssueLinkTarget } from "./githubIssueThreadLinks.logic";

const STORAGE_KEY = "t3code:github-issue-handoffs:v1";
/** Drafts are few; the oldest handoffs go first once abandoned drafts pile up. */
const MAX_HANDOFFS = 50;

type HandoffStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isLinkTarget(value: unknown): value is GitHubIssueLinkTarget {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.host === "string" &&
    typeof entry.repository === "string" &&
    typeof entry.number === "number" &&
    typeof entry.url === "string"
  );
}

/**
 * The issue each unsent draft was opened to work on, keyed by draft rather than thread: a draft
 * keeps its id through reuse, promotion, and a failed send that re-mints its thread id. Persisted,
 * so a reload before the first send still links.
 */
export function createGitHubIssueHandoffStore(storage: HandoffStorage) {
  const read = (): Record<string, GitHubIssueLinkTarget> => {
    try {
      const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, GitHubIssueLinkTarget] =>
          isLinkTarget(entry[1]),
        ),
      );
    } catch {
      return {};
    }
  };
  const write = (handoffs: Record<string, GitHubIssueLinkTarget>) => {
    const entries = Object.entries(handoffs).slice(-MAX_HANDOFFS);
    if (entries.length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  };
  return {
    record(draftId: string, target: GitHubIssueLinkTarget): void {
      const { [draftId]: _replaced, ...rest } = read();
      write({ ...rest, [draftId]: target });
    },
    /** Reads and forgets the draft's issue, so only the first successful send links it. */
    take(draftId: string): GitHubIssueLinkTarget | null {
      const { [draftId]: target, ...rest } = read();
      if (target === undefined) return null;
      write(rest);
      return target;
    },
  };
}

type GitHubIssueHandoffStore = ReturnType<typeof createGitHubIssueHandoffStore>;

/**
 * The handoff links a started send owes: one per started thread whose environment keeps issue
 * links, all sourced `handoff`. Called only once a turn has started, so a failed send leaves the
 * draft's issue in place for the retry.
 */
export function takeGitHubIssueHandoffLinks(input: {
  readonly store: GitHubIssueHandoffStore;
  readonly draftId: string | null;
  readonly threadRefs: ReadonlyArray<ScopedThreadRef>;
  readonly supportsThreadIssues: (environmentId: ScopedThreadRef["environmentId"]) => boolean;
}) {
  if (input.draftId === null || input.threadRefs.length === 0) return [];
  const target = input.store.take(input.draftId);
  if (target === null) return [];
  return input.threadRefs
    .filter((threadRef) => input.supportsThreadIssues(threadRef.environmentId))
    .map((threadRef) => ({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        host: target.host,
        repository: target.repository,
        number: target.number,
        url: target.url,
        source: "handoff" as const,
      },
    }));
}
