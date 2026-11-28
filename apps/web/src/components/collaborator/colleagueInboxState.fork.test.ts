import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { threadTriagePermitted } from "~/state/use-orchestration-command";
import { readSendPermittedFork } from "./collaboratorAccess.fork";
import { closeColleagueInboxFork, colleagueInboxAtom } from "./colleagueInboxState.fork";
import { readEnvironmentScopeDenied } from "~/state/session";

it("browsing a colleague's inbox denies operate on their environment only, except a shared thread's send, even with no session there (offline), until it closes", () => {
  const alex = EnvironmentId.make("alex");
  const mine = EnvironmentId.make("mine");
  expect(threadTriagePermitted(alex)).toBe(true);

  appAtomRegistry.set(colleagueInboxAtom, alex);
  expect(threadTriagePermitted(alex)).toBe(false);
  expect(threadTriagePermitted(mine)).toBe(true);
  expect(readEnvironmentScopeDenied(alex, AuthOrchestrationReadScope)).toBe(false);
  expect(readSendPermittedFork(alex, { collaboratorFork: "send" })).toBe(true);
  expect(readSendPermittedFork(alex, { collaboratorFork: "approve" })).toBe(true);
  expect(readSendPermittedFork(alex, { collaboratorFork: "frozen" })).toBe(false);
  expect(readSendPermittedFork(alex, {})).toBe(false);

  closeColleagueInboxFork(mine);
  expect(readEnvironmentScopeDenied(alex, AuthOrchestrationOperateScope)).toBe(true);
  closeColleagueInboxFork(alex);
  expect(threadTriagePermitted(alex)).toBe(true);
});
