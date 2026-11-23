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

import { readComposerDraftPrompt, useComposerDraftStore } from "~/composerDraftStore";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { threadSharesQuery } from "./collaboratorAccess.fork";

const typistsSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
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

/** Live only on a thread with someone to tell: shared by this host, or a collaborator's copy. */
export function CollaboratorTypingFork({ thread }: { readonly thread: TypingThread }) {
  const served =
    useServerConfigs().get(thread.environmentId)?.environment.capabilities.collaboratorsFork ===
    true;
  const asHost = served && thread.collaboratorFork === undefined;
  const { data: shares } = useEnvironmentQuery(
    asHost
      ? threadSharesQuery({ environmentId: thread.environmentId, input: { threadId: thread.id } })
      : null,
  );
  const live =
    thread.collaboratorFork === "send" ||
    thread.collaboratorFork === "approve" ||
    (shares?.sharedWith.length ?? 0) > 0;
  return live ? (
    <SharedThreadTyping environmentId={thread.environmentId} threadId={thread.id} />
  ) : null;
}

function SharedThreadTyping({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const registry = useContext(RegistryContext);
  const typists =
    useEnvironmentQuery(typistsSubscription({ environmentId, input: { threadId } })).data ?? [];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- heartbeats from the draft store outside React, so keystrokes never re-render; unmount stops
  useEffect(() => {
    const target = scopeThreadRef(environmentId, threadId);
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
  }, [registry, environmentId, threadId]);

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
