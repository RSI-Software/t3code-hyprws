// Fork-owned team-project mark (colleague-collab). Upstream project structs carry it as one
// optional `teamFork` key, which stock clients drop; absent means not a team project.
import * as Schema from "effect/Schema";

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
