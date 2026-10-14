import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
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

describe("Issues list preferences", () => {
  it("restores order and filter rows after an unmount and remount", async () => {
    using _storage = { [Symbol.dispose]: () => localStorage.clear() };
    await using first = await render(<Controls />, { router: false });
    await act(() => {
      first.container.querySelectorAll("button")[0]!.click();
      first.container.querySelectorAll("button")[1]!.click();
    });
    const expected = JSON.stringify({
      order: { sort: "comments", direction: "asc" },
      narrowing: [{ field: "label", operator: "is-not", values: ["ui"] }],
    });
    expect(first.container.querySelector("output")?.textContent).toBe(expected);
    await first.unmount();
    await using second = await render(<Controls />, { router: false });
    expect(second.container.querySelector("output")?.textContent).toBe(expected);
  });
});
