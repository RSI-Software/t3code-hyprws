// Fork-only (colleague-collab): a collaborator's message shows their own words beside their
// name, styled like an upstream guest's, while its text keeps the attributed form the agent read.
import { CollaboratorAttributionFork, PeopleLinesContextFork } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isAttribution = Schema.is(CollaboratorAttributionFork);
const isPeopleLines = Schema.is(PeopleLinesContextFork);

/** Spike RSI-711: the people-only lines an `@agent` message carried, shown above it. */
export function peopleLinesFork(context: object | undefined) {
  const lines =
    context !== undefined && "peopleLinesFork" in context ? context.peopleLinesFork : undefined;
  return isPeopleLines(lines) ? lines : undefined;
}

export function collaboratorPresentationFork(context: object | undefined) {
  const attribution =
    context !== undefined && "collaboratorFork" in context ? context.collaboratorFork : undefined;
  if (!isAttribution(attribution)) {
    const people = peopleLinesFork(context);
    return people === undefined
      ? undefined
      : { text: people.text, attribution: null, scheduledTaskId: undefined };
  }
  return {
    text: attribution.text,
    attribution: "guest" as const,
    scheduledTaskId: undefined,
    guestName: attribution.name,
  };
}
