import { AuthOrchestrationReadScope, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("reads GitHub issues without granting mutation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.githubIssuesList)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.githubIssuesDetail)).toBe(
      AuthOrchestrationReadScope,
    );
  });
});
