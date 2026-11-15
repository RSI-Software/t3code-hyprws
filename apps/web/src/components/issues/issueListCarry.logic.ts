import type {
  EnvironmentIssueListEntry,
  MergedIssueList,
} from "@t3tools/client-runtime/state/issues";
import type { IssueListInput } from "@t3tools/contracts";

/**
 * Which projects a question covers, leaving out the state and search that narrow it. Rows read for
 * one scope can stand in for another question in the same scope; rows from other projects cannot.
 */
export function issueListScope(
  targets: ReadonlyArray<{ readonly environmentId: string; readonly input: IssueListInput }>,
): string {
  return JSON.stringify(
    targets.map((target) => [target.environmentId, target.input.projectId ?? null]),
  );
}

/** Free-text terms only: a qualifier like `label:bug` is GitHub's to apply, not this list's. */
function searchTerms(query: string): ReadonlyArray<string> {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0 && !term.includes(":"));
}

function entryMatches(entry: EnvironmentIssueListEntry, terms: ReadonlyArray<string>) {
  if (terms.length === 0) return true;
  const text = [
    `#${entry.number}`,
    entry.title,
    entry.repository,
    entry.author?.login ?? "",
    ...entry.labels.map((label) => label.name),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => text.includes(term));
}

/**
 * Rows already read, narrowed to what the question on its way could still show, so the list
 * narrows in place while GitHub answers instead of blanking to skeletons.
 *
 * Only a stand-in: GitHub also searches bodies and comments, so its answer may hold more. Null
 * when nothing held fits, because an empty list would claim "no issues" before GitHub has said so.
 */
export function carryIssueList(
  held: MergedIssueList,
  input: Pick<IssueListInput, "state" | "query">,
): MergedIssueList | null {
  const terms = searchTerms(input.query ?? "");
  const entries = held.entries.filter(
    (entry) => (input.state === "all" || entry.state === input.state) && entryMatches(entry, terms),
  );
  if (entries.length === 0) return null;
  return { entries, errors: [], environmentErrors: [], truncated: false };
}
