// Fork-only (colleague-collab): the menu beside Send in a shared thread. Send's modifiers already
// mean queue or steer, so other ways to send are menu items: visible, and they work on touch.
import type { OrchestrationMessageContext } from "@t3tools/contracts";
import { ChevronUpIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useGT } from "gt-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

/** Which items the menu offers; absent hides the menu. */
export interface SendMenuFork {
  readonly askAgent: boolean;
}

/** The context a forced send carries: the agent answers it, whoever the line is to. */
const forceReplyContextFork = (
  context: OrchestrationMessageContext | undefined,
): OrchestrationMessageContext => ({ version: 1, records: [], ...context, forceReplyFork: true });

// Draft keys whose send is forced. Armed only while `send` runs, so a send that never reached
// `takeForceReplyFork` (aborted, refused, deferred) leaves the next send normal.
const armed = new Set<string>();

/** Runs a composer submit as a forced send for `targetKey`. */
export const sendForcedFork = (targetKey: string, submit: () => unknown) => {
  armed.add(targetKey);
  try {
    return submit();
  } finally {
    armed.delete(targetKey);
  }
};

/** Read once where a send starts, before any wait: whether this send is forced. */
export const takeForceReplyFork = (targetKey: string) => armed.delete(targetKey);

/** The forced message's context field, when this send is forced. */
export const forceReplyMessageFork = (
  forced: boolean,
  context: () => OrchestrationMessageContext | undefined,
) => (forced ? { context: forceReplyContextFork(context()) } : {});

export function ComposerSendMenuFork({
  menu,
  hidden,
  disabled,
  targetKey,
  submit,
}: {
  readonly menu: SendMenuFork | undefined;
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly targetKey: string;
  readonly submit: () => unknown;
}) {
  const gt = useGT();
  if (!menu?.askAgent || hidden) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={disabled}
            aria-label={gt("More ways to send")}
          />
        }
      >
        <ChevronUpIcon />
      </MenuTrigger>
      <MenuPopup side="top" align="end">
        <MenuItem disabled={disabled} onClick={() => sendForcedFork(targetKey, submit)}>
          <MessageCircleQuestionIcon />
          {gt("Ask the agent")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
