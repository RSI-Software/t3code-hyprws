import { translatableError } from "@t3tools/client-runtime/errors";
import { CollaboratorMessageBusyErrorFork, ThreadId } from "@t3tools/contracts";
import { decodeMsg, msg } from "gt-react";
import { describe, expect, it } from "vite-plus/test";

import type { MessageResolver } from "~/i18n/messages";
import { collaboratorErrorTextFork } from "./collaboratorErrors.fork";

const german = ((message: string) => `de:${decodeMsg(message)}`) as MessageResolver;

describe("collaboratorErrorTextFork", () => {
  it("shows a collaborator failure in the viewer's language, not its English message", () => {
    const error = new CollaboratorMessageBusyErrorFork({ threadId: ThreadId.make("t") });
    expect(collaboratorErrorTextFork(error, german)).toBe(
      "de:Wait for the host to answer your earlier messages.",
    );
  });

  it("shows a pairing failure's marked text in the viewer's language", () => {
    const error = translatableError(msg("Failed to reach the host."));
    expect(collaboratorErrorTextFork(error, german)).toBe("de:Failed to reach the host.");
  });
});
