import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { submitServerAuthCredential } from "../../environments/primary";
import { PairingRouteSurface } from "./PairingRouteSurface";

vi.mock("../../environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary")>()),
  submitServerAuthCredential: vi.fn().mockResolvedValue(undefined),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(submitServerAuthCredential).mockClear();
  window.history.replaceState({}, "", "/pair");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderPairing() {
  const onAuthenticated = vi.fn();
  await act(() =>
    root.render(
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
    ),
  );
  return onAuthenticated;
}

describe("pairing URL tokens", () => {
  it("pairs after same-tab hash navigation and removes the token from the URL", async () => {
    const onAuthenticated = await renderPairing();
    expect(submitServerAuthCredential).not.toHaveBeenCalled();

    await act(() => {
      window.history.pushState({}, "", "/pair#token=navigation-token");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(submitServerAuthCredential).toHaveBeenCalledExactlyOnceWith("navigation-token");
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/pair");
    expect(window.location.hash).toBe("");
  });

  it("still pairs on first load and removes the token from the URL", async () => {
    window.history.replaceState({}, "", "/pair#token=initial-token");
    const onAuthenticated = await renderPairing();

    expect(submitServerAuthCredential).toHaveBeenCalledExactlyOnceWith("initial-token");
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("");
  });
});
