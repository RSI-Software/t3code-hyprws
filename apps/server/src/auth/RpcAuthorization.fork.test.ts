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
    expect(requiredScopeForRpcMethod(WS_METHODS.githubIssuesList)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.githubIssuesDetail)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.githubIssuesLinkedThreads)).toBe(
      AuthOrchestrationReadScope,
    );
  });
});
