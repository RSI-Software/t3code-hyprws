// Fork-owned team-project mark (colleague-collab). Upstream project structs carry it as one
// optional `teamFork` key, which stock clients drop; absent means not a team project.
import * as Schema from "effect/Schema";

import type { AuthEnvironmentScope } from "./auth.ts";
import { COLLABORATOR_SHARE_SCOPES } from "./collaborator.fork.ts";

/** On a project or its shell: present and true only for a team project. */
export const TeamProjectFieldFork = {
  teamFork: Schema.optional(Schema.Boolean),
};

/** On a project update, from a client or an agent tool: true marks, false unmarks, absent leaves it. */
export const TeamProjectUpdateFieldFork = {
  teamFork: Schema.optional(
    Schema.Boolean.annotate({
      description: "Marks or unmarks a team project. Only when the user asks.",
    }),
  ),
};

/** Copies an update's mark onward, as each hop of a project update copies its fields. */
export const teamProjectChangeFork = (input: { readonly teamFork?: boolean | undefined }) =>
  input.teamFork === undefined ? {} : { teamFork: input.teamFork };

/**
 * A team mark shows every thread of the project to colleagues, so changing it takes the rights
 * sharing one thread does, on top of what the rest of the update needs.
 */
export const withTeamProjectScopesFork = <M extends { readonly teamFork?: boolean | undefined }>(
  { teamFork, ...unmarked }: M,
  scopesOf: (unmarked: Omit<M, "teamFork">) => ReadonlyArray<AuthEnvironmentScope>,
): ReadonlyArray<AuthEnvironmentScope> =>
  teamFork === undefined
    ? scopesOf(unmarked)
    : [...new Set([...scopesOf(unmarked), ...COLLABORATOR_SHARE_SCOPES])];
