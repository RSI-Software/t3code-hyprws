import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { githubIssueEnvironment } from "../../state/githubIssues";
import { environmentServerConfigsAtom } from "../../state/server";
import { toastManager } from "../ui/toast";
import {
  createGitHubIssueHandoffStore,
  takeGitHubIssueHandoffLinks,
} from "./githubIssueHandoff.logic";

const memoryStorage = new Map<string, string>();

export const githubIssueHandoffs = createGitHubIssueHandoffStore(
  typeof window !== "undefined" && window.localStorage
    ? window.localStorage
    : {
        getItem: (name) => memoryStorage.get(name) ?? null,
        setItem: (name, value) => void memoryStorage.set(name, value),
        removeItem: (name) => void memoryStorage.delete(name),
      },
);

/**
 * Links the draft's handed-off issue to the threads its send just started. The chat view calls
 * this after a turn start succeeds, foreground or background, single or multi-model.
 */
export function linkGitHubIssueHandoffFork(
  draftId: string | null,
  threadRefs: ReadonlyArray<ScopedThreadRef>,
): void {
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const links = takeGitHubIssueHandoffLinks({
    store: githubIssueHandoffs,
    draftId,
    threadRefs,
    supportsThreadIssues: (environmentId) =>
      configs.get(environmentId)?.environment.capabilities.threadIssues === true,
  });
  for (const link of links) {
    void runAtomCommand(appAtomRegistry, githubIssueEnvironment.linkToThread, link, {
      reportFailure: false,
    }).then((result) => {
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not link issue #${link.input.number} to the thread`,
        description: failure instanceof Error ? failure.message : undefined,
      });
    });
  }
}
