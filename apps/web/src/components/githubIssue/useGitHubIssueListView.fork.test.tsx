// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useGitHubIssueListViewFork } from "./useGitHubIssueListView.fork";

function Controls() {
  const { order, narrowing, setOrder, setNarrowing } = useGitHubIssueListViewFork();
  return (
    <>
      <button onClick={() => setOrder({ sort: "comments", direction: "asc" })}>Order</button>
      <button
        onClick={() => setNarrowing([{ field: "label", operator: "is-not", values: ["ui"] }])}
      >
        Filter
      </button>
      <output>{JSON.stringify({ order, narrowing })}</output>
    </>
  );
}

afterEach(() => localStorage.clear());

describe("Issues list preferences", () => {
  it("restores order and filter rows after an unmount and remount", async () => {
    const container = document.createElement("div");
    let root = createRoot(container);
    await act(async () => root.render(<Controls />));
    await act(async () => {
      container.querySelectorAll("button")[0]!.click();
      container.querySelectorAll("button")[1]!.click();
    });
    const expected = JSON.stringify({
      order: { sort: "comments", direction: "asc" },
      narrowing: [{ field: "label", operator: "is-not", values: ["ui"] }],
    });
    expect(container.querySelector("output")?.textContent).toBe(expected);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Controls />));
    expect(container.querySelector("output")?.textContent).toBe(expected);
    await act(async () => root.unmount());
  });
});
