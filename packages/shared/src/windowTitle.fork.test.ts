import { describe, expect, it } from "vite-plus/test";

import { composeFilteredWindowTitle, hubFilterTitleFork } from "./windowTitle.fork.ts";

describe("window title filter label", () => {
  it("Title: a filtered window shows the filter label after the app name", () => {
    expect(composeFilteredWindowTitle("T3 Code", "api, web")).toBe("T3 Code — api, web");
  });

  it("Title: all projects shows the app name alone", () => {
    expect(composeFilteredWindowTitle("T3 Code", null)).toBe("T3 Code");
    expect(composeFilteredWindowTitle("T3 Code", "")).toBe("T3 Code");
  });

  it("Title: the hub keeps its own name and takes only the page's filter label, if any", () => {
    expect(hubFilterTitleFork("hub", "T3 Code (hyprws)", "T3 Code (Alpha) — api, web")).toBe(
      "T3 Code (hyprws) — api, web",
    );
    expect(hubFilterTitleFork("hub", "T3 Code (hyprws)", "T3 Code (Alpha)")).toBeNull();
    expect(hubFilterTitleFork("hub", "T3 Code (hyprws)", "")).toBeNull();
  });

  it("Title: a project window keeps upstream's title", () => {
    expect(hubFilterTitleFork("project", "T3 Code (hyprws)", "T3 Code — api")).toBeNull();
  });
});
