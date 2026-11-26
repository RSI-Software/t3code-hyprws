// Fork-only (colleague-collab): on a collaborator's copy, the host's messages carry the host's name,
// as saved with the colleague, or "the host"; never "You".
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { use } from "react";

import { MessageAuthorHeading } from "../chat/TimelineRowParts";
import { TimelineRowCtx } from "../chat/timelineRowContext";
import type { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { useCollaboratorSessionFork } from "./collaboratorAccess.fork";
import { useSharerNamesFork } from "./SharedThreadCard.fork";

type Attribution = ReturnType<typeof resolveUserMessagePresentation>["attribution"];

function useHostLabel(environmentId: EnvironmentId) {
  const gt = useGT();
  const name = useSharerNamesFork().get(environmentId);
  return { name, label: name === undefined ? gt("The host") : gt("{name} (host)", { name }) };
}

/** Above the host's message on a collaborator's copy. `announce` reads it out where no heading does. */
export function HostMessageNameFork({
  environmentId,
  attribution,
  announce = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly attribution: Attribution | undefined;
  readonly announce?: boolean;
}) {
  const collaborator = useCollaboratorSessionFork(environmentId);
  return collaborator && attribution === null ? (
    <HostName environmentId={environmentId} announce={announce} />
  ) : null;
}

function HostName({
  environmentId,
  announce,
}: {
  readonly environmentId: EnvironmentId;
  readonly announce: boolean;
}) {
  const { name, label } = useHostLabel(environmentId);
  return (
    <p className="me-1 text-2xs text-muted-foreground" aria-hidden={announce ? undefined : true}>
      <span aria-hidden>{name ?? label}</span>
      <span className="sr-only">{label}</span>
    </p>
  );
}

/** A collaborator's own messages carry their name, so each "You" heading on their copy is the host's. */
export function useHostHeadingFork(heading: string) {
  const gt = useGT();
  const environmentId = use(TimelineRowCtx).activeThreadEnvironmentId;
  const collaborator = useCollaboratorSessionFork(environmentId);
  return collaborator && heading === gt("You", { $context: "author of the user's own message" }) ? (
    <HostHeading environmentId={environmentId} />
  ) : null;
}

function HostHeading({ environmentId }: { readonly environmentId: EnvironmentId }) {
  return <MessageAuthorHeading>{useHostLabel(environmentId).label}</MessageAuthorHeading>;
}
