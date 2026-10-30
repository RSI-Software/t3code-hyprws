import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { submitServerAuthCredential } from "../../environments/primary";
import { useColleagueLinkLandingFork } from "./ColleagueLinkLanding.fork";
import { sharedThreadPathFork } from "./colleagueLink.fork";

vi.mock("../../environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary")>()),
  submitServerAuthCredential: vi.fn().mockResolvedValue(undefined),
}));
// Never settles, so the test page is not navigated away.
vi.mock("./colleagueLink.fork", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./colleagueLink.fork")>()),
  sharedThreadPathFork: vi.fn(() => new Promise<string>(() => {})),
}));

function PairRoute() {
  return useColleagueLinkLandingFork({
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "t3_session",
    },
  });
}

describe("colleague link landing", () => {
  it("pairs only on continue, then opens the shared thread", async () => {
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

    await vi.waitFor(() => expect(sharedThreadPathFork).toHaveBeenCalledExactlyOnceWith("t1"));
    expect(submitServerAuthCredential).toHaveBeenCalledExactlyOnceWith("colleague-token");
  });
});
