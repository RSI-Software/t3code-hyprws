// Fork-owned team-project mark (colleague-collab). Upstream project structs carry it as one
// optional `teamFork` key, which stock clients drop; absent means not a team project.
import * as Schema from "effect/Schema";

/**
 * On a project or its shell, true only for a team project. On a client `project.update`, true
 * marks, false unmarks, absent leaves it. Agents' project tools omit it: sharing is the user's call.
 */
export const TeamProjectFieldFork = {
  teamFork: Schema.optional(Schema.Boolean),
};

/** Copies an update's mark onward, as each hop of a project update copies its fields. */
export const teamProjectChangeFork = (input: { readonly teamFork?: boolean | undefined }) =>
  input.teamFork === undefined ? {} : { teamFork: input.teamFork };
