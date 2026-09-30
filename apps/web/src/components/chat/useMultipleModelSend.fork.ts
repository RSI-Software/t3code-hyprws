import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { linkGitHubIssueHandoffFork } from "../githubIssue/githubIssueHandoff";
import type { MultipleModelTarget } from "./chatViewSend";

/** Keep failed fanout starts out of the handoff, without consuming it before all starts settle. */
export function collectIssueHandoffFork(draftId: string | null, environmentId: EnvironmentId) {
  const targets = new Map<MultipleModelTarget, ThreadId>();
  const startedThreads: ScopedThreadRef[] = [];
  return {
    capture(target: MultipleModelTarget, threadId: ThreadId) {
      targets.set(target, threadId);
    },
    complete(target: MultipleModelTarget, started: boolean) {
      const threadId = targets.get(target);
      if (started && threadId) startedThreads.push(scopeThreadRef(environmentId, threadId));
    },
    link() {
      linkGitHubIssueHandoffFork(draftId, startedThreads);
    },
  };
}
