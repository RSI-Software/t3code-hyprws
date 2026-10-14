import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { submitServerAuthCredential } from "../../environments/primary";
import { PairingRouteSurface } from "./PairingRouteSurface";

vi.mock("../../environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary")>()),
  submitServerAuthCredential: vi.fn().mockResolvedValue(undefined),
}));

async function renderPairing(url = "/pair") {
  vi.mocked(submitServerAuthCredential).mockClear();
  window.history.replaceState({}, "", url);
  const onAuthenticated = vi.fn();
  const screen = await render(
    <StrictMode>
      <PairingRouteSurface
        auth={{
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        }}
        onAuthenticated={onAuthenticated}
      />
    </StrictMode>,
    { router: false },
  );
  return Object.assign(screen, { onAuthenticated });
}

describe("pairing URL tokens", () => {
  it("pairs after same-tab hash navigation and removes the token from the URL", async () => {
    await using screen = await renderPairing();
    expect(submitServerAuthCredential).not.toHaveBeenCalled();

    await act(() => {
      window.history.pushState({}, "", "/pair#token=navigation-token");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(submitServerAuthCredential).toHaveBeenCalledExactlyOnceWith("navigation-token");
    expect(screen.onAuthenticated).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/pair");
    expect(window.location.hash).toBe("");
  });

  it("still pairs on first load and removes the token from the URL", async () => {
    await using screen = await renderPairing("/pair#token=initial-token");

    expect(submitServerAuthCredential).toHaveBeenCalledExactlyOnceWith("initial-token");
    expect(screen.onAuthenticated).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("");
  });
});
