// Fork-owned team-project controls (colleague-collab): the project settings switch, the
// sidebar chooser mark and the command-palette toggle. Upstream files carry marked hook lines.
import { AuthAccessWriteScope } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { UsersIcon } from "lucide-react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import {
  type ProjectGroupUpdate,
  useProjectGroupUpdate,
  useProjectPin,
} from "../../hooks/useProjectGroupUpdate";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentsWithScope } from "../../state/session";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { SettingsRow } from "../settings/settingsLayout";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { collaboratorsServedFork } from "./collaboratorShareDialogState.fork";

type TeamMember = Pick<
  SidebarProjectGroupMember,
  "environmentId" | "id" | "environmentLabel" | "teamFork"
>;
type TeamGroup = { readonly memberProjects: ReadonlyArray<TeamMember> };

/** A project is team once any of its checkouts is marked, as a pin is. */
const isTeamProject = (members: ReadonlyArray<TeamMember>) =>
  members.some((member) => member.teamFork === true);

/**
 * A team mark shows every thread to colleagues, so the server asks for sharing rights on each
 * checkout's machine (`withTeamProjectScopesFork`); the controls follow it. A stock server drops
 * the mark, so they show only where a checkout's server keeps it.
 */
function useCanMarkTeamFork() {
  const configs = useServerConfigs();
  const environments = [...new Set(useProjects().map((project) => project.environmentId))].map(
    (environmentId) => ({ environmentId }),
  );
  const sharing = useEnvironmentsWithScope(environments, AuthAccessWriteScope);
  return (members: ReadonlyArray<TeamMember>) =>
    members.some((member) => collaboratorsServedFork(configs, member.environmentId)) &&
    members.every((member) => sharing.has(member.environmentId));
}

export function TeamProjectSettingsRowFork(props: {
  readonly members: ReadonlyArray<TeamMember>;
  readonly disabled: boolean;
  readonly organize: (input: ProjectGroupUpdate, failureTitle: string) => Promise<void>;
}) {
  const gt = useGT();
  const canMarkTeam = useCanMarkTeamFork();
  // As Share is: hidden without the rights; the sidebar mark still shows a team project.
  if (!canMarkTeam(props.members)) return null;
  return (
    <SettingsRow
      title={gt("Team")}
      description={gt("Marks the project as your team's work.")}
      control={
        <Switch
          checked={isTeamProject(props.members)}
          disabled={props.disabled}
          onCheckedChange={(checked) =>
            void props.organize(
              { teamFork: Boolean(checked) },
              checked ? gt("Failed to mark team project") : gt("Failed to unmark team project"),
            )
          }
          aria-label={gt("Team project")}
        />
      }
    />
  );
}

export function TeamProjectMarkFork({ project }: { readonly project: TeamGroup | null }) {
  const gt = useGT();
  if (project === null || !isTeamProject(project.memberProjects)) return null;
  const label = gt("Team project");
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0 text-muted-foreground" />}>
        <UsersIcon aria-label={label} role="img" className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The palette's Mark as team project / Unmark, beside Pin project and under the same rule. */
export function useTeamProjectPaletteFork() {
  const gt = useGT();
  const { canPinProjectGroup } = useProjectPin();
  const canMarkTeam = useCanMarkTeamFork();
  const { updateProjectGroup } = useProjectGroupUpdate();
  return (
    items: { readonly push: (item: CommandPaletteActionItem) => number },
    group: (TeamGroup & { readonly displayName: string; readonly pinned: boolean }) | null,
  ) => {
    if (group === null || !canPinProjectGroup(group) || !canMarkTeam(group.memberProjects)) return;
    const team = isTeamProject(group.memberProjects);
    items.push({
      kind: "action",
      value: "action:project-team",
      searchTerms: ["team", "colleague", "teammate", "share", "project"],
      title: team ? gt("Unmark team project") : gt("Mark as team project"),
      description: group.displayName,
      icon: <UsersIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await updateProjectGroup(
          group.memberProjects,
          { teamFork: !team },
          team ? gt("Failed to unmark team project") : gt("Failed to mark team project"),
        );
      },
    });
  };
}
