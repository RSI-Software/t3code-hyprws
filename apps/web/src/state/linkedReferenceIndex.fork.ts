import type { OrchestrationV2ThreadShell, ProjectId, ThreadId } from "@t3tools/contracts";

import type { PullRequestReferenceSummary } from "../components/chat/referenceTrigger.fork";

const GITHUB_HOST = "github.com";

/** A linked snapshot, with the thread that holds it so a stale one can ask that thread to sync. */
export interface LinkedReference {
  readonly summary: PullRequestReferenceSummary;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly syncedAt: string;
}

const EMPTY_INDEX: ReadonlyMap<string, LinkedReference> = new Map();

export const linkedReferenceKey = (repository: string, number: number) =>
  `${repository.toLowerCase()}#${number}`;

/**
 * What each GitHub pull request linked to any thread looks like, from the snapshots the
 * server's sync reactors keep on thread shells. The freshest snapshot wins when threads share one.
 */
export function linkedReferenceIndex(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyMap<string, LinkedReference> {
  const index = new Map<string, LinkedReference>();
  for (const thread of threads) {
    const put = (
      link: { readonly repository: string; readonly number: number },
      syncedAt: string,
      summary: PullRequestReferenceSummary,
    ) => {
      const key = linkedReferenceKey(link.repository, link.number);
      const previous = index.get(key);
      if (previous === undefined || previous.syncedAt < syncedAt) {
        const { repository, number } = link;
        index.set(key, {
          summary,
          threadId: thread.id,
          projectId: thread.projectId,
          repository,
          number,
          syncedAt,
        });
      }
    };
    for (const link of thread.pullRequests ?? []) {
      const snapshot = link.snapshot;
      if (link.host !== GITHUB_HOST || snapshot === null) continue;
      put(link, snapshot.syncedAt, {
        title: snapshot.title,
        url: link.url,
        state: snapshot.state === "open" && snapshot.isDraft ? "draft" : snapshot.state,
        author: snapshot.author
          ? { login: snapshot.author.login, avatarUrl: snapshot.author.avatarUrl }
          : null,
        updatedAt: snapshot.updatedAt ?? snapshot.syncedAt,
      });
    }
  }
  return index.size === 0 ? EMPTY_INDEX : index;
}
