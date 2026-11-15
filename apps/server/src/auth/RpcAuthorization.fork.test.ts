import { AuthOrchestrationReadScope, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("keeps fork activity notifications behind the same read scope as turn refreshes", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsSubscribeActivityRefreshesFork)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsSubscribeRefreshes)).toBe(
      AuthOrchestrationReadScope,
    );
  });
  it("reads GitHub issues without granting mutation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.issuesList)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.issuesDetail)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.issuesLinkedThreads)).toBe(
      AuthOrchestrationReadScope,
    );
  });
});
