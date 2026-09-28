import { expect, it, vi } from "vite-plus/test";

import { readProjectChooserHost, subscribeProjectChooserHost } from "./projectChooser.fork";
import { startFilteredDocumentTitleFork } from "./windowTitle.fork";

vi.mock("./projectChooser.fork", () => ({
  readProjectChooserHost: vi.fn(),
  subscribeProjectChooserHost: vi.fn(),
}));

it("keeps upstream thread titles and changes the filter suffix without accumulating it", async () => {
  const listeners = new Set<() => void>();
  vi.mocked(subscribeProjectChooserHost).mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const filter = (titleLabel: string | null) => {
    vi.mocked(readProjectChooserHost).mockReturnValue(
      titleLabel === null
        ? null
        : {
            titleLabel,
            scope: titleLabel,
            label: titleLabel,
            open() {},
            filter: { entries: [] },
            setFilter() {},
            groups: [],
          },
    );
    for (const listener of listeners) listener();
  };
  const previousTitle = document.title;
  try {
    document.title = "First thread — Project — T3 Code";
    filter("Project");
    using _subscription = { [Symbol.dispose]: startFilteredDocumentTitleFork() };
    expect(document.title).toBe("First thread — Project — T3 Code | Project");
    document.title = "Renamed thread — Project — T3 Code";
    await vi.waitFor(() =>
      expect(document.title).toBe("Renamed thread — Project — T3 Code | Project"),
    );
    filter("Other project");
    await vi.waitFor(() =>
      expect(document.title).toBe("Renamed thread — Project — T3 Code | Other project"),
    );
    filter(null);
    await vi.waitFor(() => expect(document.title).toBe("Renamed thread — Project — T3 Code"));
  } finally {
    document.title = previousTitle;
  }
  expect(listeners.size).toBe(0);
});
