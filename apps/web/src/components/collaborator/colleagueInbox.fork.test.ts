import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { threadTriagePermitted } from "~/state/use-orchestration-command";
import { closeColleagueInboxFork, colleagueInboxAtom } from "./colleagueInbox.fork";
import { readEnvironmentScopeDenied } from "~/state/session";

it("browsing a colleague's inbox denies operate on their environment only, even with no session there (offline), until it closes", () => {
  const alex = EnvironmentId.make("alex");
  const mine = EnvironmentId.make("mine");
  expect(threadTriagePermitted(alex)).toBe(true);

  appAtomRegistry.set(colleagueInboxAtom, alex);
  expect(threadTriagePermitted(alex)).toBe(false);
  expect(threadTriagePermitted(mine)).toBe(true);
  expect(readEnvironmentScopeDenied(alex, AuthOrchestrationReadScope)).toBe(false);

  closeColleagueInboxFork(mine);
  expect(readEnvironmentScopeDenied(alex, AuthOrchestrationOperateScope)).toBe(true);
  closeColleagueInboxFork(alex);
  expect(threadTriagePermitted(alex)).toBe(true);
});
