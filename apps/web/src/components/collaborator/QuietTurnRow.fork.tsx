// Fork-only (colleague-collab): the agent's slot when the server marked its reply quiet, because a
// shared-thread message was between people. Never shows the reply's marker text.
import { T } from "gt-react";
import { EarIcon } from "lucide-react";

import type { TimelineRow } from "../chat/timelineRowContext";

type MessageRow = Extract<TimelineRow, { kind: "message" }>;

export const isQuietTurnFork = (row: MessageRow) =>
  row.projectedItem?.item.type === "assistant_message" && row.projectedItem.item.quietFork === true;

export function QuietTurnRowFork() {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-muted-foreground text-xs">
      <EarIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="italic">
        <T>Agent stayed quiet</T>
      </span>
    </div>
  );
}
