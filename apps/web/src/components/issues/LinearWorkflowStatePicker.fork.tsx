import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  LINEAR_ISSUE_HOST,
  type EnvironmentId,
  type IssueCloseReason,
  type IssueDetail,
  type IssueState,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { issueEnvironment } from "../../state/issues";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { issueStatePresentation } from "./issuePresentation";

/** How a Linear state category folds to open or closed. */
function foldedLinearState(type: string): { state: IssueState; reason?: IssueCloseReason } {
  if (type === "completed") return { state: "closed", reason: "completed" };
  if (type === "canceled" || type === "duplicate") {
    return { state: "closed", reason: "not planned" };
  }
  return { state: "open" };
}

/**
 * A Linear issue's state badge, which opens its team's workflow states. It wears the GitHub state
 * badge's look; Linear moves an issue between many states, so the badge is the control.
 */
export function LinearWorkflowStatePicker({
  environmentId,
  detail,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: IssueDetail;
  readonly onChanged: () => void;
}) {
  const runSetState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const [moving, setMoving] = useState(false);
  const current = detail.workflowState;
  const states = detail.workflowStates ?? [];
  const presentation = issueStatePresentation(detail.state, detail.closeReason);
  if (current === undefined) return null;

  const move = async (id: string) => {
    const target = states.find((state) => state.id === id);
    if (target === undefined || id === current.id || moving) return;
    setMoving(true);
    const result = await runSetState({
      environmentId,
      input: {
        projectId: detail.projectId,
        repository: detail.repository,
        number: detail.number,
        host: LINEAR_ISSUE_HOST,
        workflowStateId: id,
        ...foldedLinearState(target.type),
      },
    });
    setMoving(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not move the issue to ${target.name}`,
        description: failure instanceof Error ? failure.message : "Check the issue in Linear.",
      });
      return;
    }
    toastManager.add({ type: "success", title: `Issue moved to ${target.name}` });
    onChanged();
  };

  return (
    <Menu>
      <MenuTrigger
        disabled={moving}
        render={
          <Badge
            size="control"
            variant="outline"
            render={<button type="button" aria-label={`State: ${current.name}. Change state`} />}
          />
        }
      >
        <span className={cn("flex items-center gap-1", presentation.toneClassName)}>
          <presentation.Icon aria-hidden className="size-3.5" />
          {current.name}
        </span>
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <MenuRadioGroup value={current.id ?? null} onValueChange={(id) => void move(String(id))}>
          {states.map((state) => (
            <MenuRadioItem key={state.id} value={state.id} closeOnClick>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full border border-border"
                  style={state.color ? { backgroundColor: state.color } : undefined}
                />
                {state.name}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
