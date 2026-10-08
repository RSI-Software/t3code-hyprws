import type { OrchestrationV2AppThread } from "@t3tools/contracts";

/** A fork copies conversation and checkout settings, not the source's live controls. */
export function freshConversationForkMetadataFork() {
  return {
    checkoutMove: undefined,
    historyOrigin: undefined,
    linkedPullRequest: null,
    pullRequests: [],
    issues: [],
    branchPullRequest: null,
    unsettledAt: null,
    limitRecovery: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    autoSettleDisabledAt: null,
    titleRegeneration: null,
    rollbackRequestId: undefined,
    rollbackFailure: null,
  } satisfies Partial<OrchestrationV2AppThread>;
}

// A subagent thread also records `forkedFrom` (its parent node); only lineage marks a conversation fork.
// Turn-start harnesses pass partial threads without lineage, so read it defensively.
function isConversationForkFork(thread: OrchestrationV2AppThread) {
  return (
    (thread.lineage as OrchestrationV2AppThread["lineage"] | undefined)?.relationshipToParent ===
    "fork"
  );
}

/** Initial generation is for a new conversation, never a copied one. Explicit regeneration stays available. */
export function allowsInitialConversationTitleFork(thread: OrchestrationV2AppThread) {
  return !isConversationForkFork(thread);
}

/**
 * Tells a fork's agent who it is once per native conversation: on its first turn, and again
 * whenever T3 replaces the native thread. Later turns already carry it in native history.
 */
export function conversationForkContextFork(
  thread: OrchestrationV2AppThread,
  freshNativeThread: boolean,
) {
  if (!isConversationForkFork(thread) || !freshNativeThread) return "";
  const origin = thread.forkedFrom;
  const sourceThreadId = origin?.type === "run" ? origin.threadId : thread.lineage.parentThreadId;
  const cutoff =
    origin == null
      ? "not recorded"
      : origin.type === "run"
        ? `source run ${origin.runId}`
        : origin.type === "node"
          ? `source node ${origin.nodeId}`
          : `source provider thread ${origin.providerThreadId}${origin.providerTurnId ? `, turn ${origin.providerTurnId}` : ""}`;
  return [
    "[T3 Code conversation fork: authoritative current-thread context]",
    `Current thread ID: ${thread.id}`,
    `Source thread ID: ${sourceThreadId ?? "not recorded"}`,
    `Copied history cutoff: ${cutoff}. Later source activity is not part of this fork.`,
    "Copied messages and tool results describe historical source activity. Their thread, run, task and child IDs are not the current thread's identity or owned work.",
    "New children belong to the thread that creates them. Do not resume, poll, steer, interrupt or claim a source-owned child/task as this fork's work. Inspect current ownership before acting on historical IDs.",
    "Conversation state is separate, but the filesystem is not cloned: the fork initially shares the source checkout and branch. Coordinate file and Git changes with other threads using that checkout.",
    "Explicit issue/PR links and watches are not inherited; a PR discovered from the shared branch is a separate association.",
    "[/T3 Code conversation fork]",
  ].join("\n");
}

export function appendConversationForkContextFork(
  context: string,
  notice: string,
  compact: boolean,
) {
  // Native compact adapters need the original command unchanged.
  return [context, compact ? "" : notice].filter((part) => part !== "").join("\n\n");
}

/**
 * Replay normalizers use this: recorded transcripts predate the notice, so a frame compares
 * as the turn text without it. Returns `undefined` when the text carries no notice.
 */
export function withoutConversationForkNoticeFork(text: string) {
  const start = text.indexOf("[T3 Code conversation fork:");
  const closing = "[/T3 Code conversation fork]";
  const end = text.indexOf(closing, start);
  if (start === -1 || end === -1) return undefined;
  const before = text.slice(0, start);
  const after = text.slice(end + closing.length);
  return before === ""
    ? after.replace(/^\n\nUser message:\n/, "")
    : `${before.replace(/\n\n$/, "")}${after}`;
}
