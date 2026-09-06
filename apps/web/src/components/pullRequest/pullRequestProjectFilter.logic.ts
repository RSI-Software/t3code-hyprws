import type { EnvironmentId } from "@t3tools/contracts";

interface FilterProject {
  readonly environmentId: EnvironmentId;
  readonly title: string;
}

/**
 * One picker entry per project, exactly as the hub route derived them before
 * the repository collapse landed: a title the workspace carries twice is told
 * apart by the environment it lives on rather than left as two identical
 * rows. Multiple checkouts of one repository stay separate entries.
 */
export function pullRequestFilterProjects<Project extends FilterProject>(
  projects: ReadonlyArray<Project>,
  environmentLabels: ReadonlyMap<EnvironmentId, string>,
) {
  // Two machines can hold the same repository, so a title the workspace carries twice is told
  // apart by the environment it lives on rather than left as two identical rows.
  const titleCounts = new Map<string, number>();
  for (const project of projects) {
    titleCounts.set(project.title, (titleCounts.get(project.title) ?? 0) + 1);
  }
  return projects
    .map((project) => ({
      ...project,
      title:
        (titleCounts.get(project.title) ?? 0) > 1
          ? `${project.title} · ${environmentLabels.get(project.environmentId) ?? project.environmentId}`
          : project.title,
    }))
    .toSorted((left, right) => left.title.localeCompare(right.title));
}
