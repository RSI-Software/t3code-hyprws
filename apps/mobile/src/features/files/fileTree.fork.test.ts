import { describe, expect, it } from "vite-plus/test";

import { buildFileTree } from "./fileTree";

describe("mobile file tree helpers", () => {
  it("preserves ignored state for dimmed file-tree rows", () => {
    const tree = buildFileTree([
      { kind: "directory", path: ".dump", ignored: true },
      { kind: "file", path: ".dump/report.md", ignored: true },
    ]);

    expect(tree[0]).toMatchObject({ path: ".dump", ignored: true });
    expect(tree[0]?.children[0]).toMatchObject({ path: ".dump/report.md", ignored: true });
  });
});
