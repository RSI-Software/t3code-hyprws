// Fork-only (colleague-collab): who a thread can go to in one click. Saved colleagues need no link;
// anyone else shared before still does.
import type { CollaboratorFork, ColleagueFork } from "@t3tools/contracts";

/** A saved colleague as a thread menu or palette entry; `shared` makes it the way back out. */
export interface ColleagueShareTargetFork {
  readonly subject: string;
  readonly name: string;
  readonly shared: boolean;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

const isIn = (people: ReadonlyArray<CollaboratorFork>) => (person: CollaboratorFork) =>
  people.some((other) => other.subject === person.subject);

export function colleagueShareTargets(
  colleagues: ReadonlyArray<ColleagueFork>,
  sharedWith: ReadonlyArray<CollaboratorFork>,
): ReadonlyArray<ColleagueShareTargetFork> {
  const shared = isIn(sharedWith);
  return colleagues
    .map(({ subject, name }) => ({ subject, name, shared: shared({ subject, name }) }))
    .toSorted(byName);
}

/** The share dialog's chips: colleagues to share with in one click, then others shared before. */
export function shareSuggestions(
  colleagues: ReadonlyArray<ColleagueFork>,
  shares: {
    readonly sharedWith: ReadonlyArray<CollaboratorFork>;
    readonly collaborators: ReadonlyArray<CollaboratorFork>;
  },
) {
  const shared = isIn(shares.sharedWith);
  const colleague = isIn(colleagues);
  return {
    colleagues: colleagues.filter((person) => !shared(person)).toSorted(byName),
    sharedBefore: shares.collaborators.filter((person) => !shared(person) && !colleague(person)),
  };
}

const MENU_PREFIX = "share-colleague:";

export const colleagueShareMenuIdFork = (subject: string) => `${MENU_PREFIX}${subject}` as const;

/** The colleague a thread menu entry names; null for any other entry. */
export const colleagueForMenuId = (
  action: string,
  targets: ReadonlyArray<ColleagueShareTargetFork>,
): ColleagueShareTargetFork | undefined | null =>
  action.startsWith(MENU_PREFIX)
    ? targets.find((target) => colleagueShareMenuIdFork(target.subject) === action)
    : null;
