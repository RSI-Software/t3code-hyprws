// Fork-only (colleague-collab): a collaborator's message shows their own words beside their
// name, styled like an upstream guest's, while its text keeps the attributed form the agent read.
import { CollaboratorAttributionFork } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isAttribution = Schema.is(CollaboratorAttributionFork);

export function collaboratorPresentationFork(context: object | undefined) {
  const attribution =
    context !== undefined && "collaboratorFork" in context ? context.collaboratorFork : undefined;
  if (!isAttribution(attribution)) return undefined;
  return {
    text: attribution.text,
    attribution: "guest" as const,
    scheduledTaskId: undefined,
    guestName: attribution.name,
  };
}
