// Fork-only (colleague-collab): a collaborator link offers a shared thread, not a backend, and opens
// that thread once its pairing succeeds. A plain pairing link falls through to the upstream flow.
import {
  fetchRemoteEnvironmentDescriptor,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { COLLABORATOR_THREAD_LINK_PARAM, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Effect from "effect/Effect";

import { requestConfirmDialog } from "../../confirmDialog";
import { connectPairing } from "../../connection/onboarding";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";
import * as PrimaryEnvironmentHttpLayer from "../../environments/primary/httpLayer";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The shared thread a collaborator link names, if any. */
export const linkThreadIdFork = (pairingUrl: string) =>
  new URL(pairingUrl).searchParams.get(COLLABORATOR_THREAD_LINK_PARAM)?.trim();

/** The shared thread on this server, or home when the server cannot name its environment. */
export const sharedThreadPathFork = (threadId: string) =>
  Effect.runPromise(
    fetchRemoteEnvironmentDescriptor({ httpBaseUrl: resolvePrimaryEnvironmentHttpUrl("/") }).pipe(
      Effect.provide(PrimaryEnvironmentHttpLayer.layer),
      Effect.map(({ environmentId }) => `/${environmentId}/${encodeURIComponent(threadId)}`),
      Effect.orElseSucceed(() => "/"),
    ),
  );

const reportFailure = (error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not open the shared thread",
      description: error instanceof Error ? error.message : "Failed to reach the host.",
    }),
  );

/** Returns a handler that takes a collaborator link end to end; it returns false for any other link. */
export function useCollaboratorLinkPairingFork() {
  const router = useRouter();
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  return async (pairingUrl: string, origin: string, paired: Set<string>): Promise<boolean> => {
    const threadId = linkThreadIdFork(pairingUrl);
    if (!threadId) return false;
    const confirmed =
      (await requestConfirmDialog(
        `Open the thread shared with you from ${origin}? Your messages run on their machine.`,
      )) ?? false;
    if (!confirmed) return true;
    const result = await connect({ pairingUrl });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) reportFailure(squashAtomCommandFailure(result));
      return true;
    }
    paired.add(pairingUrl);
    toastManager.add({
      type: "success",
      title: "Shared thread added",
      description: "It sits in your sidebar beside your own threads.",
    });
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(result.value, ThreadId.make(threadId))),
    });
    return true;
  };
}
