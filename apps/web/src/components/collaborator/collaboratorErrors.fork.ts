// Fork-only (colleague-collab): a collaborator failure in the viewer's language. The contract's
// errors carry fixed English messages, so the copy for the ones people see lives here.
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { msg } from "gt-react";

import { type MessageResolver, m } from "~/i18n/messages";

const COPY: Readonly<Record<string, string>> = {
  CollaboratorThreadMissingErrorFork: msg("This thread no longer exists."),
  CollaboratorShareErrorFork: msg("Could not share the thread."),
  CollaboratorMessageMissingErrorFork: msg("That message was already sent or dismissed."),
  CollaboratorMessageBusyErrorFork: msg("Wait for the host to answer your earlier messages."),
  CollaboratorMessageDeliveryErrorFork: msg("Could not deliver the message."),
  ColleagueForkThreadErrorFork: msg("Could not fork the thread to this machine."),
};

/** Collaborator errors by their copy here; any other by its marked text, else its message. */
export function collaboratorErrorTextFork(
  error: unknown,
  resolve: MessageResolver = m,
): string | null {
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : null;
  const copy = typeof tag === "string" ? COPY[tag] : undefined;
  return copy === undefined ? errorDisplayMessage(error, resolve) : resolve(copy);
}
