// Fork-only (colleague-collab): open the thread a colleague link names once its pairing succeeds.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { COLLEAGUE_THREAD_LINK_PARAM, type EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { useRouter } from "@tanstack/react-router";

import { buildThreadRouteParams } from "../../threadRoutes";

export async function openColleagueSharedThreadFork(
  router: ReturnType<typeof useRouter>,
  pairingUrl: string,
  environmentId: EnvironmentId,
): Promise<void> {
  const threadId = new URL(pairingUrl).searchParams.get(COLLEAGUE_THREAD_LINK_PARAM)?.trim();
  if (!threadId) return;
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(scopeThreadRef(environmentId, ThreadId.make(threadId))),
  });
}
