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
import { msg, useGT, useMessages } from "gt-react";
import { useContext, useEffect } from "react";

import {
  type ComposerThreadTarget,
  type DraftId,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { connectionAtomRuntime } from "~/connection/runtime";
import { randomUUID } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { Badge } from "../ui/badge";
import { collaboratorDraftFork, withinActive } from "./collaboratorDraft.fork";

export const typingSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:collaborator:typing",
    tag: WS_METHODS.collaboratorSubscribeTypingFork,
  },
);

const setTypingCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "share typing",
  tag: WS_METHODS.collaboratorSetTypingFork,
  // A stop must not overtake the start before it.
  concurrency: {
    mode: "serial",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
  },
});

/** The host as cites key them: never a collaborator's name, which needs a letter or digit. */
export const HOST_KEY = "";

// At most four sends a second while the draft changes, the last always arriving.
const THROTTLE_MS = 250;
// The server forgets a typist after five seconds without one, so a paused draft stays shown.
const KEEPALIVE_MS = 2_000;

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
    // This composer's own slot, so a person's other devices never replace or stop its draft.
    const device = randomUUID();
    const send = (input: { typing: true; draft: CollaboratorDraftFork } | { typing: false }) =>
      runAtomCommand(
        registry,
        setTypingCommand,
        { environmentId, input: { threadId, device, ...input } },
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
      const draft = withinActive(collaboratorDraftFork(source, threadId), Date.now() - editedAt);
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
        } else if (open) {
          flushAfter(KEEPALIVE_MS);
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
    // A draft already open, as after a reload, shares its citations without waiting for an edit.
    flush();
    return () => {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
      if (open) void send({ typing: false });
    };
  }, [registry, environmentId, threadId, editDraftId, shared]);

  // A draft of only this thread's citations shows on the cited passages instead.
  const writing = typists.filter(
    ({ draft }) => draft === undefined || draft.text !== "" || draft.chips.length > 0,
  );
  return writing.length === 0 ? null : (
    <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 px-3 pb-2">
      {writing.map((typist) => (
        <DraftPreview key={`${typist.subject}:${typist.device ?? ""}`} typist={typist} />
      ))}
    </div>
  );
}

const KIND_NAMES: Readonly<Record<string, string>> = {
  image: msg("Image"),
  file: msg("File"),
  terminal: msg("Terminal"),
  "review-comment": msg("Review comment"),
  "preview-annotation": msg("Preview annotation"),
  thread: msg("Thread"),
  response: msg("Response"),
  environment: msg("Environment"),
  citation: msg("Citation"),
};

// A kind this client does not know yet shows as its own words.
const kindName = (kind: string, messages: ReturnType<typeof useMessages>) => {
  const known = KIND_NAMES[kind];
  if (known !== undefined) return messages(known);
  const spaced = kind.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** Static text, its end kept when clamped, since the latest words matter most. */
function DraftPreview({ typist }: { readonly typist: CollaboratorTypistFork }) {
  const gt = useGT();
  const messages = useMessages();
  const { name, draft } = typist;
  const caption =
    draft === undefined
      ? name === undefined
        ? gt("The host is typing…")
        : gt("{name} is typing…", { name })
      : name === undefined
        ? gt("The host is writing")
        : gt("{name} is writing", { name });
  return (
    <figure className="flex min-w-0 flex-col gap-1 rounded-xl border border-dashed border-border bg-background px-3 py-2">
      <figcaption className="text-muted-foreground text-xs">{caption}</figcaption>
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
                  {gt("{kind}: {label}", {
                    kind: kindName(chip.kind, messages),
                    label: chip.label,
                  })}
                </span>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}
