import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthSessionState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { connectionsSessionScopesFork } from "./connectionsSessionScopes.fork";

const standardSession: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "t3_session",
  },
  scopes: [AuthOrchestrationReadScope],
};

describe("connectionsSessionScopesFork", () => {
  it("reads a client-only attach's scopes from its session", () => {
    const scopes = connectionsSessionScopesFork(
      {},
      AuthStandardClientScopes,
      standardSession,
      true,
    );
    expect(scopes).toEqual([AuthOrchestrationReadScope]);
    expect(scopes?.includes(AuthAccessWriteScope)).toBe(false);
  });

  it("holds nothing while a client-only launch has no session", () => {
    expect(connectionsSessionScopesFork({}, AuthStandardClientScopes, null, true)).toBeNull();
  });

  it("keeps owned scopes for a desktop that owns its backend", () => {
    expect(connectionsSessionScopesFork({}, AuthStandardClientScopes, null, false)).toBe(
      AuthStandardClientScopes,
    );
  });

  it("reads a browser's scopes from its session", () => {
    expect(
      connectionsSessionScopesFork(undefined, AuthStandardClientScopes, standardSession, false),
    ).toEqual([AuthOrchestrationReadScope]);
  });

  it("prefers the session's permissions over its legacy scopes", () => {
    const session: AuthSessionState = { ...standardSession, permissions: [AuthAccessWriteScope] };
    const scopes = connectionsSessionScopesFork({}, AuthStandardClientScopes, session, true);
    expect(scopes).toEqual([AuthAccessWriteScope]);
  });
});
