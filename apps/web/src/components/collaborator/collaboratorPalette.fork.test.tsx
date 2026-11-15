import { describe, expect, it, vi } from "vite-plus/test";

import { buildShareWithCollaboratorActionItemFork } from "./collaboratorPalette.fork";

vi.mock("../../state/session", () => ({ readEnvironmentScope: vi.fn() }));
vi.mock("./collaboratorShareDialogState.fork", () => ({
  openCollaboratorShareDialog: vi.fn(),
}));

describe("Share with collaborator palette entry", () => {
  it.each([null, undefined])("omits the action without an active thread (%s)", (thread) => {
    expect(buildShareWithCollaboratorActionItemFork(thread)).toBeNull();
  });
});
