import type { ScopedProjectRef } from "@t3tools/contracts";

import type { WindowProjectListScope, WindowProjectScopeParam } from "../windowProjectScope";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

export function WindowProjectScopeToggle({
  forcedProjectRef,
  listScope,
  onNavigate,
}: {
  readonly forcedProjectRef: ScopedProjectRef | null;
  readonly listScope: WindowProjectListScope;
  /** Updates the route with replace semantics and clears the current detail selection. */
  readonly onNavigate: (urlScope: WindowProjectScopeParam | undefined) => void;
}) {
  if (forcedProjectRef === null) return null;

  return (
    <ToggleGroup
      aria-label="Project scope"
      variant="segmented"
      value={[listScope.kind]}
      onValueChange={(values) => {
        const nextScope = values[0];
        if (nextScope !== "all" && nextScope !== "project") return;
        if (nextScope === listScope.kind) return;
        onNavigate(nextScope === "all" ? "all" : undefined);
      }}
    >
      <Toggle value="project">This project</Toggle>
      <Toggle value="all">All projects</Toggle>
    </ToggleGroup>
  );
}
