// Fork-owned: the thread header's "Add project" for a thread whose project lies
// outside the window's project filter (RSI-Software/t3code-hyprws#1353). The
// thread stays open and readable; the action only adds its project's entry.
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useMemo } from "react";

import { useProjectChooserHostValue } from "../../projectChooser.fork";
import { addProjectFilterEntry, outsideFilterProjectGroup } from "../../projectFilterScope.fork";
import { Button } from "../ui/button";

export function OutsideFilterAddProjectFork(props: {
  readonly project: {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  } | null;
}) {
  const chooser = useProjectChooserHostValue();
  const environmentId = props.project?.environmentId ?? null;
  const projectId = props.project?.id ?? null;
  const group = useMemo(
    () =>
      chooser === null || environmentId === null || projectId === null
        ? null
        : outsideFilterProjectGroup(
            chooser.filter,
            chooser.groups,
            scopeProjectRef(environmentId, projectId),
          ),
    [chooser, environmentId, projectId],
  );
  if (chooser === null || group === null) return null;
  return (
    <Button
      size="compact"
      variant="outline"
      title={`${group.displayName} is outside this window's projects (${chooser.label})`}
      onClick={() => chooser.setFilter(addProjectFilterEntry(chooser.filter, group))}
    >
      <PlusIcon />
      Add project
    </Button>
  );
}
