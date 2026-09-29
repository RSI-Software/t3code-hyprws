import { describe, expect, it } from "vite-plus/test";

import { gitHubIssueTypeHexColor, gitHubIssueTypeLabel } from "./githubIssueChips.logic";

describe("GitHub issue chips", () => {
  it("maps an issue type's colour name to hex and passes hex through", () => {
    expect(gitHubIssueTypeHexColor("RED")).toBe("d1242f");
    expect(gitHubIssueTypeHexColor(" purple ")).toBe("8250df");
    expect(gitHubIssueTypeHexColor("1d76db")).toBe("1d76db");
    expect(gitHubIssueTypeHexColor(null)).toBeNull();
  });

  it("adds a glyph only to a type that has none of its own", () => {
    expect(gitHubIssueTypeLabel("Bug 🐛")).toBe("Bug 🐛");
    expect(gitHubIssueTypeLabel("Bug")).toBe("Bug 🐛");
    expect(gitHubIssueTypeLabel("Tracker")).toBe("Tracker 📡");
    expect(gitHubIssueTypeLabel("Chore")).toBe("Chore");
  });
});
