import { describe, expect, it, vi } from "vite-plus/test";

// Pinned per case so each skew row reads as a fixed client/server pair.
const branding = vi.hoisted(() => ({ APP_VERSION: "0.0.43-hyprws.3" }));
vi.mock("./branding", () => branding);

import { manualServerUpdateCommand, resolveVersionMismatch } from "./versionSkew";

describe("manualServerUpdateCommand (fork)", () => {
  it.each(["0.0.43-hyprws.2", "0.0.43-hyprws-nightly.20260923.688"])(
    "installs fork version %s with t3 update",
    (version) => {
      expect(manualServerUpdateCommand(version)).toBe(`t3 update ${version}`);
    },
  );

  it("leaves an upstream version on npx", () => {
    expect(manualServerUpdateCommand("0.0.43")).toBe("npx t3@0.0.43");
  });
});

describe("resolveVersionMismatch (fork)", () => {
  it.each([
    { client: "0.0.43-hyprws.3", server: "0.0.43-hyprws.2", banner: true },
    {
      client: "0.0.43-hyprws-nightly.20260923.693",
      server: "0.0.43-hyprws-nightly.20260923.688",
      banner: true,
    },
    // Different channels keep upstream's core-only comparison.
    { client: "0.0.43-hyprws.3", server: "0.0.43-hyprws-nightly.20260923.688", banner: false },
    { client: "0.0.43-hyprws.2", server: "0.0.43-hyprws.3", banner: false },
  ])("client $client, server $server: banner $banner", ({ client, server, banner }) => {
    branding.APP_VERSION = client;
    expect(resolveVersionMismatch(server) !== null).toBe(banner);
  });
});
