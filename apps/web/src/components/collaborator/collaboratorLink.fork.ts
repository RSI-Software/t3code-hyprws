// Fork-only (colleague-collab): a collaborator link offers a shared thread, a colleague invite, or
// both, not a backend. Once paired it opens the thread; only an invite saves both sides as
// colleagues. A plain pairing link falls through to the upstream flow.
import {
  fetchRemoteEnvironmentDescriptor,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  COLLABORATOR_THREAD_LINK_PARAM,
  COLLEAGUE_INVITE_LINK_PARAM,
  ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import * as Effect from "effect/Effect";

import { requestConfirmDialog } from "../../confirmDialog";
import { connectPairing } from "../../connection/onboarding";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";
import * as PrimaryEnvironmentHttpLayer from "../../environments/primary/httpLayer";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { collaboratorErrorTextFork } from "./collaboratorErrors.fork";
import { collaboratorLinkInputFork } from "./collaboratorLinkInput.logic.fork";
import { useSaveColleagueFork } from "./colleagues.fork";

/** The shared thread a collaborator link names, if any. */
export const linkThreadIdFork = (pairingUrl: string) =>
  URL.parse(pairingUrl)?.searchParams.get(COLLABORATOR_THREAD_LINK_PARAM)?.trim() || undefined;

/** The colleague invite a collaborator link carries, if any. */
export const linkColleagueInviteFork = (pairingUrl: string) =>
  URL.parse(pairingUrl)?.searchParams.get(COLLEAGUE_INVITE_LINK_PARAM)?.trim() || undefined;

/** The shared thread on this server, or home when the server cannot name its environment. */
export const sharedThreadPathFork = (threadId: string) =>
  Effect.runPromise(
    fetchRemoteEnvironmentDescriptor({ httpBaseUrl: resolvePrimaryEnvironmentHttpUrl("/") }).pipe(
      Effect.provide(PrimaryEnvironmentHttpLayer.layer),
      Effect.map(({ environmentId }) => `/${environmentId}/${encodeURIComponent(threadId)}`),
      Effect.orElseSucceed(() => "/"),
    ),
  );

/** Returns a handler that takes a collaborator link end to end; it returns false for any other link. */
export function useCollaboratorLinkPairingFork() {
  const gt = useGT();
  const reportFailure = (error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Could not open the shared thread"),
        description: collaboratorErrorTextFork(error) ?? gt("Failed to reach the host."),
      }),
    );
  const router = useRouter();
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const saveColleague = useSaveColleagueFork();
  return async (
    pairingUrl: string,
    linkOrigin?: string,
    paired = new Set<string>(),
  ): Promise<boolean> => {
    const threadId = linkThreadIdFork(pairingUrl);
    const invite = linkColleagueInviteFork(pairingUrl);
    if (!threadId && !invite) return false;
    const origin = linkOrigin ?? new URL(pairingUrl).origin;
    const question = !threadId
      ? gt("Save {origin} as a colleague? You then share threads with each other without a link.", {
          origin,
        })
      : invite
        ? gt(
            "Open the thread shared with you from {origin}, and save them as a colleague? Your messages run on their machine.",
            { origin },
          )
        : gt("Open the thread shared with you from {origin}? Your messages run on their machine.", {
            origin,
          });
    const confirmed = (await requestConfirmDialog(question)) ?? false;
    if (!confirmed) return true;
    const result = await connect({ pairingUrl });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) reportFailure(squashAtomCommandFailure(result));
      return true;
    }
    paired.add(pairingUrl);
    if (invite) void saveColleague(result.value, invite);
    if (!threadId) return true;
    toastManager.add({
      type: "success",
      title: gt("Shared thread added"),
      description: gt("It sits in your sidebar beside your own threads."),
    });
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(result.value, ThreadId.make(threadId))),
    });
    return true;
  };
}

/** Takes a collaborator link typed or pasted where a backend address goes; false for anything else. */
export function usePastedCollaboratorLinkFork() {
  const pair = useCollaboratorLinkPairingFork();
  return (value: string, setValue: (value: string) => void, onDone: () => void) => {
    const input = collaboratorLinkInputFork(value);
    if (input.kind === "other") return false;
    setValue(value);
    if (input.kind === "whole") void pair(input.link).then(onDone);
    return true;
  };
}
