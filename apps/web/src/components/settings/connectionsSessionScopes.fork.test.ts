import {
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
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
  scopes: AuthStandardClientScopes,
};

describe("connectionsSessionScopesFork", () => {
  it("reads a client-only attach's scopes from its session", () => {
    const scopes = connectionsSessionScopesFork(
      {},
      AuthAdministrativeScopes,
      standardSession,
      true,
    );
    expect(scopes).toEqual(AuthStandardClientScopes);
    expect(scopes?.includes(AuthAccessWriteScope)).toBe(false);
  });

  it("holds nothing while a client-only launch has no session", () => {
    expect(connectionsSessionScopesFork({}, AuthAdministrativeScopes, null, true)).toBeNull();
  });

  it("keeps administrative scopes for a desktop that owns its backend", () => {
    expect(connectionsSessionScopesFork({}, AuthAdministrativeScopes, null, false)).toBe(
      AuthAdministrativeScopes,
    );
  });

  it("reads a browser's scopes from its session", () => {
    expect(
      connectionsSessionScopesFork(undefined, AuthAdministrativeScopes, standardSession, false),
    ).toEqual(AuthStandardClientScopes);
  });

  it("prefers the session's permissions over its legacy scopes", () => {
    const session: AuthSessionState = { ...standardSession, permissions: [AuthAccessWriteScope] };
    const scopes = connectionsSessionScopesFork({}, AuthAdministrativeScopes, session, true);
    expect(scopes).toEqual([AuthAccessWriteScope]);
  });
});
