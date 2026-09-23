import { FORK_RELEASE_REPOSITORY } from "@t3tools/shared/forkVersion";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { forkSupersedes } from "../../../../../scripts/lib/fork-supersedes.ts";
import { findEnvironmentUpdate } from "./environment-maintenance";

afterEach(() => vi.unstubAllGlobals());

const releases = `https://github.com/${FORK_RELEASE_REPOSITORY}/releases`;
const apiPage = (page: number) =>
  `https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;

describe("environment release checks", () => {
  const signal = new AbortController().signal;
  const feed = (...tags: ReadonlyArray<string>) =>
    new Response(
      `<feed><id>tag:github.com,2008:${releases}</id>${tags
        .map((tag) => `<entry><id>tag:github.com,2008:Repository/1/${tag}</id></entry>`)
        .join("")}</feed>`,
    );

  forkSupersedes({
    upstream:
      "apps/mobile/src/features/settings/environment-maintenance.test.ts > checks stable updates as JSON without using the anonymous API quota",
    reason: "the fork checks its own releases, not upstream's",
    commit: "c6fd4ad1e4",
  });
  it("checks stable updates as JSON without using the anonymous API quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url === `${releases}/latest` &&
        new Headers(init?.headers).get("Accept") === "application/json"
          ? Response.json({ tag_name: "v1.1.0" })
          : new Response(null, { status: 403 }),
      ),
    );
    expect(await findEnvironmentUpdate("1.0.0", signal)).toBe("1.1.0");
    expect(await findEnvironmentUpdate("1.1.0", signal)).toBeNull();
    expect(await findEnvironmentUpdate("1.3.0", signal)).toBeNull();
  });

  forkSupersedes({
    upstream:
      "apps/mobile/src/features/settings/environment-maintenance.test.ts > keeps nightly and preview hosts on their channel without using the anonymous API quota",
    reason: "the fork checks its own releases, not upstream's",
    commit: "c6fd4ad1e4",
  });
  it("keeps nightly and preview hosts on their channel without using the anonymous API quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === `${releases}.atom`
          ? feed(
              "desktop-preview",
              "v1.0.0-preview.20260924.3",
              "v1.0.0-nightly.20260924.2",
              "v1.0.0",
              "v1.0.0-nightly.20260923.1",
            )
          : new Response(null, { status: 403 }),
      ),
    );
    expect(await findEnvironmentUpdate("1.0.0-nightly.20260923.1", signal)).toBe(
      "1.0.0-nightly.20260924.2",
    );
    expect(await findEnvironmentUpdate("1.0.0-nightly.20260924.2", signal)).toBeNull();
    expect(await findEnvironmentUpdate("1.0.0-preview.20260923.1", signal)).toBe(
      "1.0.0-preview.20260924.3",
    );
    expect(await findEnvironmentUpdate("1.0.0-preview.20260925.1", signal)).toBeNull();
  });

  forkSupersedes({
    upstream:
      "apps/mobile/src/features/settings/environment-maintenance.test.ts > finds a published preview beyond the ten-entry feed and first API page",
    reason: "the fork checks its own releases, not upstream's",
    commit: "c6fd4ad1e4",
  });
  it("finds a published preview beyond the ten-entry feed and first API page", async () => {
    const nightlies = Array.from({ length: 10 }, (_, i) => `v1.0.0-nightly.20260930.${i}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === `${releases}.atom`) return feed(...nightlies);
        if (url === apiPage(1)) {
          return Response.json(Array.from({ length: 100 }, () => ({ tag_name: "v2.0.0" })));
        }
        if (url === apiPage(2)) {
          return Response.json([
            { tag_name: "v1.0.0-preview.20260925.1", draft: true },
            { tag_name: "v1.0.0-preview.20260924.3" },
          ]);
        }
        throw new Error(`Unexpected release request: ${url}`);
      }),
    );
    expect(await findEnvironmentUpdate("1.0.0-preview.20260923.1", signal)).toBe(
      "1.0.0-preview.20260924.3",
    );
  });
});
