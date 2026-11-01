import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { submitServerAuthCredential } from "../../environments/primary";
import { PairingRouteSurface } from "../auth/PairingRouteSurface";
import { useColleagueLinkLandingFork } from "./ColleagueLinkLanding.fork";

vi.mock("../../environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary")>()),
  submitServerAuthCredential: vi.fn().mockResolvedValue(undefined),
}));

// As routes/pair.tsx composes them: the landing holds the pairing surface back.
function PairRoute() {
  const landing = useColleagueLinkLandingFork(true);
  return (
    landing ?? (
      <PairingRouteSurface
        auth={{
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        }}
        onAuthenticated={() => {}}
      />
    )
  );
}

describe("colleague link landing", () => {
  it("keeps the one-time token until the colleague continues in this browser", async () => {
    window.history.replaceState({}, "", "/pair?thread=t1#token=colleague-token");
    const pairingUrl = window.location.href;
    await using screen = await render(<PairRoute />, { router: false });

    const appLink = screen.getByRole("link", { name: "Open in desktop app" });
    await expect.element(appLink).toBeVisible();
    const href = appLink.element().getAttribute("href") ?? "";
    expect(new URL(href).searchParams.get("pairingUrl")).toBe(pairingUrl);
    expect(submitServerAuthCredential).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#token=colleague-token");

    await screen.getByRole("button", { name: "Continue in this browser" }).click();

    await vi.waitFor(() =>
      expect(submitServerAuthCredential).toHaveBeenCalledExactlyOnceWith("colleague-token"),
    );
  });
});
