// Fork-only (colleague-collab): "<Name> is typing…" above a shared thread's composer. Each side
// heartbeats while its draft changes; no draft text leaves the client.
import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ThreadId, WS_METHODS } from "@t3tools/contracts";
import { useContext, useEffect } from "react";

import {
  type ComposerThreadTarget,
  type DraftId,
  readComposerDraftPrompt,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";

const typingSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:collaborator:typing",
  tag: WS_METHODS.collaboratorSubscribeTypingFork,
});

const setTypingCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "share typing",
  tag: WS_METHODS.collaboratorSetTypingFork,
  // A stop must not overtake the start before it.
  concurrency: {
    mode: "serial",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
  },
});

// The server forgets a typist after five seconds without one.
const HEARTBEAT_MS = 2_000;

interface TypingThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly collaboratorFork?: "send" | "approve" | "frozen";
}

/** One idle subscription per open thread; heartbeats only while the server says it is shared. */
export function CollaboratorTypingFork({
  thread,
  draftTarget,
}: {
  readonly thread: TypingThread;
  readonly draftTarget: ComposerThreadTarget;
}) {
  const served =
    useServerConfigs().get(thread.environmentId)?.environment.capabilities.collaboratorsFork ===
    true;
  return served && thread.collaboratorFork !== "frozen" ? (
    <ThreadTyping
      environmentId={thread.environmentId}
      threadId={thread.id}
      // A queued-message edit types into a draft of its own.
      editDraftId={typeof draftTarget === "string" ? draftTarget : null}
    />
  ) : null;
}

function ThreadTyping({
  environmentId,
  threadId,
  editDraftId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly editDraftId: DraftId | null;
}) {
  const registry = useContext(RegistryContext);
  const state = useEnvironmentQuery(
    typingSubscription({ environmentId, input: { threadId } }),
  ).data;
  const shared = state?.shared === true;
  const typists = state?.typists ?? [];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- heartbeats from the draft store outside React, so keystrokes never re-render; unsharing or unmount stops
  useEffect(() => {
    if (!shared) return;
    const target = editDraftId ?? scopeThreadRef(environmentId, threadId);
    const send = (typing: boolean) =>
      void runAtomCommand(
        registry,
        setTypingCommand,
        { environmentId, input: { threadId, typing } },
        { reportFailure: false, reportDefect: false },
      );
    let previous = readComposerDraftPrompt(target);
    let beatAt: number | null = null;
    const unsubscribe = useComposerDraftStore.subscribe(() => {
      const prompt = readComposerDraftPrompt(target);
      if (prompt === previous) return;
      previous = prompt;
      if (!prompt?.trim()) {
        if (beatAt !== null) send(false);
        beatAt = null;
      } else if (beatAt === null || Date.now() - beatAt >= HEARTBEAT_MS) {
        beatAt = Date.now();
        send(true);
      }
    });
    return () => {
      unsubscribe();
      if (beatAt !== null) send(false);
    };
  }, [registry, environmentId, threadId, editDraftId, shared]);

  const [first] = typists;
  return (
    <p
      aria-live="polite"
      className="mx-auto w-full max-w-(--chat-content-max-width) px-3 empty:hidden pb-1 text-muted-foreground text-xs"
    >
      {first === undefined
        ? null
        : typists.length > 1
          ? `${typists.length} people are typing…`
          : `${first.name ?? "The host"} is typing…`}
    </p>
  );
}
