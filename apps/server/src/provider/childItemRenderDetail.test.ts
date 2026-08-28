import { CHILD_ITEM_RENDER_JSON_MAX_BYTES, ChildItemRenderDetail } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { extractChildItemResultText, makeChildItemRenderDetail } from "./childItemRenderDetail.ts";

const encodeRenderDetail = Schema.encodeSync(Schema.fromJsonString(ChildItemRenderDetail));
const serializedBytes = (value: ChildItemRenderDetail) =>
  new TextEncoder().encode(encodeRenderDetail(value)).length;

describe("child item render detail", () => {
  it("keeps only relative and workspace-contained POSIX paths", () => {
    const detail = makeChildItemRenderDetail({
      workspaceRoot: "/workspace/project",
      changedFiles: [
        { path: "/workspace/project/src/inside.ts", kind: "modify" },
        { path: "src/relative.ts", kind: "add" },
        { path: "/workspace/other/outside.ts", kind: "delete" },
        { path: "//server/share/remote.ts" },
        { path: "~other/private.ts" },
        { path: "C:drive-relative.ts" },
        { path: "../traversal.ts" },
      ],
    });

    expect(detail).toEqual({
      changedFiles: [
        { path: "src/inside.ts", kind: "modified" },
        { path: "src/relative.ts", kind: "added" },
      ],
      truncated: true,
    });
  });

  it("normalizes contained Windows and UNC paths without leaking roots", () => {
    expect(
      makeChildItemRenderDetail({
        workspaceRoot: "C:\\work\\project",
        changedFiles: [
          { path: "C:\\work\\project\\src\\inside.ts" },
          { path: "C:\\work\\other\\outside.ts" },
          { path: "D:\\work\\project\\other-drive.ts" },
        ],
      }),
    ).toEqual({
      changedFiles: [{ path: "src/inside.ts" }],
      truncated: true,
    });
    expect(
      makeChildItemRenderDetail({
        workspaceRoot: "\\\\server\\share\\project",
        changedFiles: [
          { path: "\\\\server\\share\\project\\src\\inside.ts" },
          { path: "\\\\server\\other\\outside.ts" },
        ],
      }),
    ).toEqual({
      changedFiles: [{ path: "src/inside.ts" }],
      truncated: true,
    });
  });

  it("enforces one escaped serialized byte budget", () => {
    const hostile = '\u0000\n"\\'.repeat(8_000);
    const detail = makeChildItemRenderDetail({
      workspaceRoot: "/workspace/project",
      command: hostile,
      result: hostile,
      changedFiles: Array.from({ length: 12 }, (_, index) => ({
        path: `/workspace/project/${"p".repeat(220)}-${index}.ts`,
        diff: hostile,
      })),
    });

    expect(detail).toBeDefined();
    if (!detail) return;
    expect(serializedBytes(detail)).toBeLessThanOrEqual(CHILD_ITEM_RENDER_JSON_MAX_BYTES);
    expect(detail?.truncated).toBe(true);
    expect(detail?.changedFiles?.every((file) => !file.path.startsWith("/"))).toBe(true);
  });

  it("redacts shell-adjacent and quoted local paths without redacting URLs", () => {
    const detail = makeChildItemRenderDetail({
      command:
        'cat>/workspace/out.txt <C:\\Users\\alice\\secret.txt |\\\\server\\share\\secret.txt & "/workspace/My File.txt" \'C:\\Program Files\\secret.txt\' "\\\\server\\share\\My File.txt" :/workspace/colon.txt https://example.com/docs/file',
    });

    expect(detail?.command).toBe(
      'cat>[local path] <[local path] |[local path] & "[local path]" \'[local path]\' "[local path]" :[local path] https://example.com/docs/file',
    );
    expect(detail?.truncated).toBe(true);
  });

  it("extracts bounded MCP and dynamic result carriers", () => {
    const circular: Record<string, unknown> = {};
    circular.result = circular;
    const extracted = extractChildItemResultText({
      content: [{ type: "text", text: "MCP output" }],
      structuredContent: { output: "structured output" },
      result: circular,
    });

    expect(extracted.value).toBe("MCP output\nstructured output");
    expect(extracted.truncated).toBe(true);
    expect(extractChildItemResultText({ runHandles: { taskId: "private-task" } })).toEqual({
      truncated: true,
    });
  });
});
