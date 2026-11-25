// SPIKE RSI-713 (colleague-collab): a people-only side chat in a shared thread's details panel.
// The agent never reads it; "Send to agent" turns one line into its author's thread message.
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ThreadId, WS_METHODS } from "@t3tools/contracts";
import { CornerDownRightIcon, SendHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const sideChatSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:collaborator:side-chat",
  tag: WS_METHODS.collaboratorSubscribeSideChatFork,
});

const sideChatCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "side chat",
  tag: WS_METHODS.collaboratorSideChatFork,
});

interface SideChatProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export function CollaboratorSideChatFork({
  show,
  ...props
}: SideChatProps & { readonly show: boolean }) {
  const served =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.collaboratorsFork ===
    true;
  return show && served ? (
    <SideChat key={`${props.environmentId}:${props.threadId}`} {...props} />
  ) : null;
}

function SideChat({ environmentId, threadId }: SideChatProps) {
  const state = useEnvironmentQuery(
    sideChatSubscription({ environmentId, input: { threadId } }),
  ).data;
  const run = useAtomCommand(sideChatCommand);
  const [draft, setDraft] = useState("");
  if (state?.shared !== true) return null;
  const me = state.you;

  const say = () => {
    const text = draft.trim();
    if (text === "") return;
    setDraft("");
    void run({ environmentId, input: { threadId, say: text } });
  };

  return (
    <ThreadDetailsSection headingId="thread-details-side-chat-heading" title="People only">
      <div className="flex flex-col gap-2 px-2.5">
        <p className="text-2xs text-muted-foreground">
          Just the people here. The agent sees a line only when you send it.
        </p>
        <ul className="m-0 flex max-h-72 list-none flex-col gap-1.5 overflow-y-auto p-0">
          {state.lines.map((line) => {
            const mine = (line.name ?? null) === (me ?? null);
            const mayOffer = state.canSend || (mine && me !== undefined);
            return (
              <li key={line.id} className="group/line rounded-lg bg-muted/40 px-2 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-2xs font-medium text-foreground/80">
                    {mine ? "You" : (line.name ?? "Host")}
                  </span>
                  {line.sentBy === undefined && mayOffer ? (
                    <Button
                      size="micro"
                      variant="ghost-muted"
                      aria-label="Send to agent"
                      onClick={() =>
                        void run({ environmentId, input: { threadId, send: line.id } })
                      }
                    >
                      <SendHorizontalIcon />
                      {state.canSend ? "Send to agent" : "Ask host to send"}
                    </Button>
                  ) : null}
                </div>
                <p className="text-sm break-words whitespace-pre-wrap text-foreground">
                  {line.text}
                </p>
                {line.sentBy !== undefined ? (
                  <p className="mt-0.5 flex items-center gap-1 text-2xs text-muted-foreground">
                    <CornerDownRightIcon className="size-3" />
                    Sent to agent by {line.sentBy}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            say();
          }}
        >
          <Input
            size="sm"
            value={draft}
            placeholder="Message the people here…"
            aria-label="Side chat message"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" size="icon-sm" variant="outline" aria-label="Send to people">
            <SendHorizontalIcon />
          </Button>
        </form>
      </div>
    </ThreadDetailsSection>
  );
}
