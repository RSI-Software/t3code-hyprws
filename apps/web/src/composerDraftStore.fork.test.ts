import { describe, expect, it } from "vite-plus/test";

import { COMPOSER_DRAFT_STORAGE_KEY, resolveComposerDraftStorageKey } from "./composerDraftStore";

describe("composer draft persistence scope", () => {
  it("keeps the hub key unchanged and isolates physical project identities", () => {
    expect(resolveComposerDraftStorageKey("/")).toBe(COMPOSER_DRAFT_STORAGE_KEY);
    expect(resolveComposerDraftStorageKey("/settings/connections")).toBe(
      COMPOSER_DRAFT_STORAGE_KEY,
    );
    expect(resolveComposerDraftStorageKey("/project/environment-1/project-1/thread/thread-1")).toBe(
      `${COMPOSER_DRAFT_STORAGE_KEY}:project:environment-1:project-1`,
    );
    expect(resolveComposerDraftStorageKey("/project/remote%3Awsl/project%20one")).toBe(
      `${COMPOSER_DRAFT_STORAGE_KEY}:project:remote%3Awsl:project%20one`,
    );
  });

  it("does not scope malformed or incomplete project routes", () => {
    expect(resolveComposerDraftStorageKey("/project/environment-only")).toBe(
      COMPOSER_DRAFT_STORAGE_KEY,
    );
    expect(resolveComposerDraftStorageKey("/project/%E0%A4%A/project-1")).toBe(
      COMPOSER_DRAFT_STORAGE_KEY,
    );
  });
});
