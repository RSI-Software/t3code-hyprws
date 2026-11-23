// Fork-only (colleague-collab): each other person's unsent draft, read-only, above a shared thread's
// composer. Each side sends its draft while editing it; nobody edits another's.
import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  type CollaboratorDraftFork,
  type CollaboratorTypistFork,
  type EnvironmentId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { useContext, useEffect } from "react";

import {
  type ComposerThreadTarget,
  type DraftId,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { Badge } from "../ui/badge";
import { collaboratorDraftFork } from "./collaboratorDraft.fork";

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

// At most four sends a second while the draft changes, the last always arriving.
const THROTTLE_MS = 250;
// The server forgets a typist after five seconds without one, so a paused draft stays shown.
const KEEPALIVE_MS = 2_000;
// The host's devices share one typist slot, so only a draft edited here lately claims it.
const ACTIVE_MS = 30_000;

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends the draft from the store outside React, so keystrokes never re-render; unsharing or unmount stops
  useEffect(() => {
    if (!shared) return;
    const target = editDraftId ?? scopeThreadRef(environmentId, threadId);
    const readDraft = () => useComposerDraftStore.getState().getComposerDraft(target);
    const send = (input: { typing: true; draft: CollaboratorDraftFork } | { typing: false }) =>
      runAtomCommand(
        registry,
        setTypingCommand,
        { environmentId, input: { threadId, ...input } },
        { reportFailure: false, reportDefect: false },
      );
    let source = readDraft();
    // Whether the server holds this draft, so emptying it must say so.
    let open = false;
    let sentAt = Number.NEGATIVE_INFINITY;
    let editedAt = Number.NEGATIVE_INFINITY;
    let sending = false;
    let pending = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dueAt = Number.POSITIVE_INFINITY;
    const flushAfter = (delay: number) => {
      if (Date.now() + delay >= dueAt) return;
      clearTimeout(timer);
      dueAt = Date.now() + delay;
      timer = setTimeout(flush, delay);
    };
    const throttled = () => Math.max(0, THROTTLE_MS - (Date.now() - sentAt));
    // One send in flight at a time; changes meanwhile coalesce into the next.
    const flush = () => {
      dueAt = Number.POSITIVE_INFINITY;
      if (sending) {
        pending = true;
        return;
      }
      const draft = collaboratorDraftFork(source);
      if (draft === null && !open) return;
      open = draft !== null;
      sending = true;
      sentAt = Date.now();
      void send(draft === null ? { typing: false } : { typing: true, draft }).then(() => {
        sending = false;
        if (closed) return;
        if (pending) {
          pending = false;
          flushAfter(throttled());
        } else if (open && Date.now() - editedAt < ACTIVE_MS) {
          flushAfter(KEEPALIVE_MS);
        } else {
          // Gone idle: the server drops it, and this device must not stop another's.
          open = false;
        }
      });
    };
    const unsubscribe = useComposerDraftStore.subscribe(() => {
      const next = readDraft();
      if (next === source) return;
      source = next;
      editedAt = Date.now();
      flushAfter(throttled());
    });
    return () => {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
      if (open) void send({ typing: false });
    };
  }, [registry, environmentId, threadId, editDraftId, shared]);

  return typists.length === 0 ? null : (
    <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 px-3 pb-2">
      {typists.map((typist) => (
        <DraftPreview key={typist.subject} typist={typist} />
      ))}
    </div>
  );
}

const kindName = (kind: string) => {
  const spaced = kind.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** Static text, its end kept when clamped, since the latest words matter most. */
function DraftPreview({ typist }: { readonly typist: CollaboratorTypistFork }) {
  const who = typist.name ?? "The host";
  const { draft } = typist;
  return (
    <figure className="flex min-w-0 flex-col gap-1 rounded-xl border border-dashed border-border px-3 py-2">
      <figcaption className="text-muted-foreground text-xs">
        {draft === undefined ? `${who} is typing…` : `${who} is writing`}
      </figcaption>
      {draft !== undefined && draft.text.trim() !== "" ? (
        <div className="flex max-h-[4lh] flex-col justify-end overflow-hidden text-foreground/80 text-sm">
          <p className="shrink-0 whitespace-pre-wrap wrap-anywhere">
            {draft.truncated ? `…${draft.text}` : draft.text}
          </p>
        </div>
      ) : null}
      {draft !== undefined && draft.chips.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {draft.chips.map((chip, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- chips carry no id, and two can share a label
            <li key={index} className="flex min-w-0">
              <Badge variant="secondary" size="sm" className="max-w-56">
                <span className="min-w-0 truncate">
                  {kindName(chip.kind)}: {chip.label}
                </span>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}
