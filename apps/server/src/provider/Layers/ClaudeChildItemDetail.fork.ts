import type { CanonicalItemType } from "@t3tools/contracts";

import { extractChildItemResultText, makeChildItemRenderDetail } from "../childItemRenderDetail.ts";

/**
 * Structural view of the adapter's in-flight tool record. Only the fields the
 * fork's child rendering reads are named, so upstream stays free to extend
 * `ToolInFlight` without touching this sibling. `itemType` keeps upstream's
 * canonical union, so renaming `command_execution` or `file_change` fails the
 * typecheck here instead of silently never matching.
 */
export interface ClaudeChildItemTool {
  readonly itemType: CanonicalItemType;
  readonly input: Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, ...keys: ReadonlyArray<string>) {
  for (const key of keys) {
    if (typeof input[key] === "string") {
      return input[key];
    }
  }
  return undefined;
}

/**
 * Child-work rows render from the tool's own input plus whatever result text the
 * SDK attached. Redaction, truncation and the changed-file shape belong to
 * `childItemRenderDetail`; this only maps Claude's tool vocabulary onto it, so
 * the adapter keeps a single call per emission point.
 */
export function claudeChildItemRenderDetail(
  tool: ClaudeChildItemTool,
  workspaceRoot: string | undefined,
  resultSource?: unknown,
  structuredResultSource?: unknown,
) {
  const path = stringField(tool.input, "file_path", "notebook_path", "path");
  const command =
    tool.itemType === "command_execution" ? stringField(tool.input, "command", "cmd") : undefined;
  const diff = stringField(tool.input, "diff", "patch");
  const before = stringField(tool.input, "old_string", "oldText");
  const after = stringField(tool.input, "new_string", "newText", "new_source");
  const primaryResult = extractChildItemResultText(resultSource);
  const structuredResult = extractChildItemResultText(structuredResultSource);
  const result =
    structuredResult.value &&
    (!primaryResult.value || structuredResult.value.length > primaryResult.value.length)
      ? structuredResult
      : primaryResult;
  const changedFiles =
    tool.itemType === "file_change" && path
      ? [
          {
            path,
            kind: stringField(tool.input, "kind", "operation") ?? "modified",
            ...(diff ? { diff } : {}),
            ...(before !== undefined ? { before } : {}),
            ...(after !== undefined ? { after } : {}),
          },
        ]
      : undefined;
  return makeChildItemRenderDetail({
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(command ? { command } : {}),
    ...(result.value ? { result: result.value } : {}),
    ...(changedFiles ? { changedFiles } : {}),
    truncated: result.truncated,
  });
}
