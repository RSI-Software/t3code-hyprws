import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linkedReferenceIndex, linkedReferenceKey } from "./linkedReferenceIndex.fork";

const pr = (number: number, syncedAt: string, state: "open" | "merged", isDraft = false) => ({
  host: "github.com",
  repository: "Org/repo",
  number,
  url: `https://github.com/Org/repo/pull/${number}`,
  snapshot: { state, isDraft, title: `PR ${number} ${syncedAt}`, updatedAt: null, syncedAt },
});
const thread = (id: string, links: { pullRequests?: unknown[] }) =>
  ({ id, ...links }) as unknown as OrchestrationV2ThreadShell;

describe("linkedReferenceIndex", () => {
  it("maps synced snapshots to reference states, freshest snapshot winning", () => {
    const index = linkedReferenceIndex([
      thread("a", {
        pullRequests: [pr(1, "2026-01-02", "merged"), pr(2, "2026-01-01", "open", true)],
      }),
      thread("b", { pullRequests: [pr(1, "2026-01-01", "open")] }),
    ]);
    const entry = (number: number) => index.get(linkedReferenceKey("org/REPO", number));
    expect([1, 2].map((number) => entry(number)?.summary.state)).toEqual(["merged", "draft"]);
    expect(entry(1)?.threadId).toBe("a");
  });
});
