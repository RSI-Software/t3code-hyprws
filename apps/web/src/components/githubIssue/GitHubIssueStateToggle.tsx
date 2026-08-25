import type { GitHubIssueListState } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon, ListIcon } from "lucide-react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ISSUE_CONTROL_LABEL } from "./GitHubIssueListControls";

const STATE_OPTIONS = [
  { value: "open", label: "Open", Icon: CircleDotIcon },
  { value: "closed", label: "Closed", Icon: CircleCheckIcon },
  { value: "all", label: "All", Icon: ListIcon },
] as const satisfies ReadonlyArray<{
  value: GitHubIssueListState;
  label: string;
  Icon: typeof ListIcon;
}>;

/**
 * Open, closed, or both, as three pressed states rather than a menu. The set never grows, and a
 * reader flips between open and closed constantly, so the whole choice belongs on screen. Its
 * labels collapse with the other controls' once the pane runs out of room.
 */
export function GitHubIssueStateToggle({
  state,
  onState,
}: {
  readonly state: GitHubIssueListState;
  readonly onState: (state: GitHubIssueListState) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Issue state"
      variant="segmented"
      className="shrink-0"
      value={[state]}
      onValueChange={(values) => {
        const next = STATE_OPTIONS.find((option) => option.value === values[0]);
        if (next !== undefined && next.value !== state) onState(next.value);
      }}
    >
      {STATE_OPTIONS.map((option) => (
        <Toggle key={option.value} value={option.value} title={option.label}>
          <option.Icon aria-hidden className="size-4" />
          <span className={ISSUE_CONTROL_LABEL}>{option.label}</span>
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
