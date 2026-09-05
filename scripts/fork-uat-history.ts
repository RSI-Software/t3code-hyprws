// Stable tags are not ancestry boundaries because the fork stack is rebased. Carry acceptance
// conditions from the UAT associated with the selected previous stable tag.

import { requireCommandSuccess, type InputCommandRunner } from "./lib/fork-command.ts";
import { parseStableForkTag } from "./lib/fork-policy.ts";
import { legacyUatTasks, type PreviousUat, type UatTask } from "./fork-uat-policy.ts";

const REPOSITORY = "RSI-Software/t3code-hyprws";

interface UatIssueRow {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

interface UatSubIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED";
  readonly url: string;
}

const run = (runner: InputCommandRunner, command: string, args: ReadonlyArray<string>): string =>
  requireCommandSuccess(runner.run(command, args), command, args);

const json = <T>(output: string, source: string): T => {
  const start = output.search(/^[{[]/m);
  if (start === -1) throw new Error(`${source} did not print JSON`);
  return JSON.parse(output.slice(start)) as T;
};

const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const exactUatTitle = (title: string, version: string): boolean =>
  new RegExp(`^(?:\\[[^\\]]+\\] )?UAT ${regexEscape(version)}(?: \\[[^\\]]+\\])?$`).test(title);

const withoutHomingMarker = (title: string): string =>
  title.replace(/^\[[^\]]+\] /, "").replace(/ \[[^\]]+\]$/, "");

const priorTargetVersion = (stableTag: string): string => {
  const parsed = parseStableForkTag(stableTag);
  if (parsed === null) throw new Error(`previous stable ${stableTag} is not a stable fork tag`);
  return `v${parsed.major}.${parsed.minor}.${parsed.patch}-hyprws`;
};

const subIssueTasks = (
  runner: InputCommandRunner,
  issue: UatIssueRow,
  targetVersion: string,
): ReadonlyArray<UatTask> => {
  const response = json<{
    readonly subIssues: { readonly nodes: ReadonlyArray<UatSubIssue> };
  }>(
    run(runner, "gh", [
      "issue",
      "view",
      String(issue.number),
      "--repo",
      REPOSITORY,
      "--json",
      "subIssues",
    ]),
    `UAT #${issue.number} sub-issues`,
  );
  const prefix = `UAT ${targetVersion}: `;
  const tasks = response.subIssues.nodes.map((child): UatTask => {
    const title = withoutHomingMarker(child.title);
    if (!title.startsWith(prefix) || !title.slice(prefix.length).includes(" — ")) {
      throw new Error(`UAT #${issue.number} has unrecognized acceptance child #${child.number}`);
    }
    const [area, ...condition] = title.slice(prefix.length).split(" — ");
    return {
      area: area ?? "Acceptance",
      title: condition.join(" — "),
      carriedFrom: [
        {
          issue: issue.number,
          status: child.state === "CLOSED" ? "accepted" : "unsettled",
        },
      ],
    };
  });
  if (tasks.length === 0) throw new Error(`UAT #${issue.number} has no acceptance children`);
  return tasks;
};

export const readPreviousUat = (
  runner: InputCommandRunner,
  previousStable: string,
): PreviousUat | null => {
  const targetVersion = priorTargetVersion(previousStable);
  const response = json<ReadonlyArray<UatIssueRow>>(
    run(runner, "gh", [
      "issue",
      "list",
      "--repo",
      REPOSITORY,
      "--state",
      "all",
      "--label",
      "release",
      "--search",
      `"UAT ${targetVersion}" in:title`,
      "--limit",
      "1000",
      "--json",
      "number,title,body,url",
    ]),
    "repository UAT issues",
  );
  const matching = response.filter((issue) => exactUatTitle(issue.title, targetVersion));
  if (matching.length > 1) {
    throw new Error(`multiple UAT issues match previous stable ${targetVersion}`);
  }
  const issue = matching[0];
  if (issue === undefined) return null;
  const tasks = issue.body.includes("<!-- fork-uat:subissues:v1 -->")
    ? subIssueTasks(runner, issue, targetVersion)
    : legacyUatTasks(issue.body, issue.number);
  if (tasks.length === 0)
    throw new Error(`previous UAT #${issue.number} has no acceptance conditions`);
  return { issue: issue.number, url: issue.url, tasks };
};
