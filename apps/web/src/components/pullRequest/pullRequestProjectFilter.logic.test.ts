import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestFilterProjects } from "./pullRequestProjectFilter.logic";

const cups = EnvironmentId.make("env-cups");
const nucbox = EnvironmentId.make("env-nucbox");
const labels = new Map([
  [cups, "cups"],
  [nucbox, "nucbox-1"],
]);

function project(
  id: string,
  environmentId = nucbox,
  canonicalKey: string | null = "github.com/pingdotgg/t3code",
) {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "t3code",
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: canonicalKey === null ? null : { canonicalKey },
    faviconPath: `${id}/favicon.png`,
    projectIcon: null,
  };
}

/**
 * The pre-repair inline derivation from `_chat.pull-requests.tsx`
 * (`origin/hyprws`): one entry per project, title collisions told apart by the
 * environment they live on. Copied here so the boundary helper proves parity
 * against the exact block it replaced.
 */
function legacyScopedProjects(
  projects: ReadonlyArray<ReturnType<typeof project>>,
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
      id: project.id,
      environmentId: project.environmentId,
      title:
        (titleCounts.get(project.title) ?? 0) > 1
          ? `${project.title} · ${environmentLabels.get(project.environmentId) ?? project.environmentId}`
          : project.title,
      workspaceRoot: project.workspaceRoot,
      faviconPath: project.faviconPath ?? null,
      projectIcon: project.projectIcon ?? null,
    }))
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

const asPickerRows = (
  rows: ReadonlyArray<{ id: unknown; environmentId: unknown; title: unknown }>,
) => rows.map(({ id, environmentId, title }) => ({ id, environmentId, title }));

describe("pull request project filter choices", () => {
  it("matches the pre-repair inline derivation row for row on the same fixture", () => {
    const projects = [
      project("main"),
      project("worktree-1"),
      project("worktree-2"),
      project("main", cups),
      { ...project("app", cups), title: "Zebra" },
    ];

    expect(asPickerRows(pullRequestFilterProjects(projects, labels))).toEqual(
      asPickerRows(legacyScopedProjects(projects, labels)),
    );
  });

  it("keeps three checkouts on one server as three entries with disambiguated titles", () => {
    const projects = [
      project("main"),
      project("worktree-1"),
      project("worktree-2"),
      project("main", cups),
    ];

    const choices = pullRequestFilterProjects(projects, labels);

    // The repository collapse is gone: every project stays its own entry and
    // only the colliding title is told apart by the environment it lives on.
    expect(asPickerRows(choices)).toEqual([
      { id: "main", environmentId: cups, title: "t3code · cups" },
      { id: "main", environmentId: nucbox, title: "t3code · nucbox-1" },
      { id: "worktree-1", environmentId: nucbox, title: "t3code · nucbox-1" },
      { id: "worktree-2", environmentId: nucbox, title: "t3code · nucbox-1" },
    ]);
    expect(choices[1]?.workspaceRoot).toBe("/work/main");
    expect(choices[1]?.faviconPath).toBe("main/favicon.png");
  });

  it("leaves unique titles alone and orders them alphabetically", () => {
    const app = { ...project("app"), title: "Zebra" };
    const tools = { ...project("tools", nucbox, "github.com/acme/tools"), title: "Alpha" };

    expect(pullRequestFilterProjects([app, tools], labels)).toEqual([
      { ...tools, title: "Alpha" },
      { ...app, title: "Zebra" },
    ]);
    expect(pullRequestFilterProjects([], labels)).toEqual([]);
  });

  it("uses the environment id when its label is unavailable", () => {
    const choices = pullRequestFilterProjects(
      [project("main"), project("remote", cups)],
      new Map(),
    );

    expect(choices.map((choice) => choice.title)).toEqual([
      "t3code · env-cups",
      "t3code · env-nucbox",
    ]);
  });
});
