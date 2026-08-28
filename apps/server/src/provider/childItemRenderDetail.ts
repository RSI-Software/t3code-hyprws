// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import {
  CHILD_ITEM_RENDER_CHANGED_FILES_MAX_ITEMS,
  CHILD_ITEM_RENDER_COMMAND_MAX_CHARS,
  CHILD_ITEM_RENDER_DIFF_MAX_CHARS,
  CHILD_ITEM_RENDER_JSON_MAX_BYTES,
  CHILD_ITEM_RENDER_PATH_MAX_CHARS,
  CHILD_ITEM_RENDER_RESULT_MAX_CHARS,
  type ChildItemRenderChangedFile,
  type ChildItemRenderDetail,
} from "@t3tools/contracts";

const encoder = new TextEncoder();
const RESULT_CARRIER_MAX_DEPTH = 3;
const RESULT_CARRIER_MAX_ITEMS = 16;
const RESULT_CARRIER_MAX_CHARS = CHILD_ITEM_RENDER_RESULT_MAX_CHARS * 2;
const PATH_INPUT_MAX_CHARS = CHILD_ITEM_RENDER_PATH_MAX_CHARS * 4;

type RawChangedFile = {
  readonly path?: unknown;
  readonly kind?: unknown;
  readonly diff?: unknown;
  readonly before?: unknown;
  readonly after?: unknown;
};

type MutableChangedFile = {
  path: string;
  kind?: ChildItemRenderChangedFile["kind"];
  diff?: string;
};

type MutableRenderDetail = {
  command?: string;
  result?: string;
  changedFiles?: MutableChangedFile[];
  truncated: boolean;
};

export interface ChildItemRenderDetailInput {
  readonly workspaceRoot?: string;
  readonly command?: unknown;
  readonly result?: unknown;
  readonly changedFiles?: ReadonlyArray<unknown>;
  readonly truncated?: boolean;
}

interface BoundedText {
  readonly value?: string;
  readonly truncated: boolean;
}

function redactInlineLocalPaths(value: string): BoundedText {
  const quoted = value.replace(
    /(["'])(?:file:\/\/|~[^\s/\\]*[/\\]|\\\\|\/\/|\/(?!\/)|[a-z]:(?:[/\\])?)[^"'\r\n]*\1/giu,
    (_match: string, quote: string) => `${quote}[local path]${quote}`,
  );
  const redacted = quoted.replace(
    /(^|[\s"'`([\]{;,=<>|&:])((?:file:\/\/|~[^\s/\\]*[/\\]|\\\\|\/\/|\/(?!\/)|[a-z]:(?:[/\\])?)[^\s"'`<>\])},;|&]*)/giu,
    (match: string, prefix: string, path: string, offset: number, source: string) => {
      if (
        prefix === ":" &&
        path.startsWith("//") &&
        /[a-z][a-z0-9+.-]*$/iu.test(source.slice(0, offset))
      ) {
        return match;
      }
      return `${prefix}[local path]`;
    },
  );
  return { value: redacted, truncated: redacted !== value };
}

function truncateUtf8(value: string, maxBytes: number): BoundedText {
  if (encoder.encode(value).length <= maxBytes) {
    return { value, truncated: false };
  }

  const suffix = "…";
  const suffixBytes = encoder.encode(suffix).length;
  if (maxBytes < suffixBytes) {
    return { truncated: true };
  }
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes + suffixBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return { value: `${result}${suffix}`, truncated: true };
}

function boundedText(value: unknown, maxBytes: number): BoundedText {
  if (typeof value !== "string") {
    return { truncated: value !== undefined && value !== null };
  }
  const maxInputChars = maxBytes * 2;
  const inputWasBounded = value.length > maxInputChars;
  const trimmed = value.slice(0, maxInputChars).trim();
  if (!trimmed) {
    return { truncated: inputWasBounded };
  }
  const redacted = redactInlineLocalPaths(trimmed);
  const bounded = truncateUtf8(redacted.value ?? "", maxBytes);
  return {
    ...(bounded.value ? { value: bounded.value } : {}),
    truncated: inputWasBounded || redacted.truncated || bounded.truncated,
  };
}

type PathFlavor = "posix" | "windows";

function pathFlavor(value: string): PathFlavor | undefined {
  if (/^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\") || value.startsWith("//")) {
    return "windows";
  }
  return value.startsWith("/") ? "posix" : undefined;
}

function isUnsafeUnresolvedPath(value: string): boolean {
  let hasControlCharacter = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      hasControlCharacter = true;
      break;
    }
  }
  return (
    hasControlCharacter ||
    /^file:\/\//iu.test(value) ||
    /^~[^/\\]*(?:[/\\]|$)/u.test(value) ||
    /^[a-z]:(?![/\\])/iu.test(value)
  );
}

function containedRelativePath(
  value: string,
  workspaceRoot: string | undefined,
): string | undefined {
  const fileFlavor = pathFlavor(value);
  if (!fileFlavor || !workspaceRoot) {
    return undefined;
  }
  if (workspaceRoot.length > PATH_INPUT_MAX_CHARS) {
    return undefined;
  }
  const boundedRoot = workspaceRoot.trim();
  const rootFlavor = pathFlavor(boundedRoot);
  if (rootFlavor !== fileFlavor || isUnsafeUnresolvedPath(boundedRoot)) {
    return undefined;
  }
  const pathApi = fileFlavor === "windows" ? NodePath.win32 : NodePath.posix;
  const relative = pathApi.relative(pathApi.resolve(boundedRoot), pathApi.resolve(value));
  if (!relative || relative === ".." || relative.startsWith(`..${pathApi.sep}`)) {
    return undefined;
  }
  if (pathApi.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replaceAll("\\", "/");
}

function safeRelativePath(value: unknown, workspaceRoot?: string): BoundedText {
  if (typeof value !== "string") {
    return { truncated: value !== undefined && value !== null };
  }
  const inputWasBounded = value.length > PATH_INPUT_MAX_CHARS;
  const trimmed = value.slice(0, PATH_INPUT_MAX_CHARS).trim();
  if (!trimmed || inputWasBounded || isUnsafeUnresolvedPath(trimmed)) {
    return { truncated: inputWasBounded || trimmed.length > 0 };
  }

  const absoluteFlavor = pathFlavor(trimmed);
  const relative = absoluteFlavor
    ? containedRelativePath(trimmed, workspaceRoot)
    : trimmed.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.split("/").includes("..") ||
    isUnsafeUnresolvedPath(relative)
  ) {
    return { truncated: true };
  }
  const bounded = truncateUtf8(
    NodePath.posix.normalize(relative),
    CHILD_ITEM_RENDER_PATH_MAX_CHARS,
  );
  return {
    ...(bounded.value ? { value: bounded.value } : {}),
    truncated: inputWasBounded || bounded.truncated,
  };
}

function normalizeChangeKind(value: unknown): ChildItemRenderChangedFile["kind"] | undefined {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
        ? (value as { type: string }).type
        : undefined;
  switch (raw?.toLowerCase()) {
    case "add":
    case "added":
    case "create":
    case "created":
      return "added";
    case "delete":
    case "deleted":
    case "remove":
    case "removed":
      return "deleted";
    case "edit":
    case "modify":
    case "modified":
    case "update":
    case "updated":
      return "modified";
    default:
      return undefined;
  }
}

function prefixedDiff(before: string | undefined, after: string | undefined): string | undefined {
  if (before === undefined && after === undefined) {
    return undefined;
  }
  const removed = before === undefined ? [] : before.split(/\r?\n/u).map((line) => `-${line}`);
  const added = after === undefined ? [] : after.split(/\r?\n/u).map((line) => `+${line}`);
  return ["--- before", "+++ after", ...removed, ...added].join("\n");
}

function changedFileDiff(change: RawChangedFile): BoundedText {
  if (typeof change.diff === "string") {
    return boundedText(change.diff, CHILD_ITEM_RENDER_DIFF_MAX_CHARS);
  }
  const before = boundedText(change.before, CHILD_ITEM_RENDER_DIFF_MAX_CHARS / 2);
  const after = boundedText(change.after, CHILD_ITEM_RENDER_DIFF_MAX_CHARS / 2);
  const synthesized = prefixedDiff(before.value, after.value);
  if (!synthesized) {
    return {
      truncated:
        before.truncated || after.truncated || (change.diff !== undefined && change.diff !== null),
    };
  }
  const bounded = truncateUtf8(synthesized, CHILD_ITEM_RENDER_DIFF_MAX_CHARS);
  return {
    ...(bounded.value ? { value: bounded.value } : {}),
    truncated: before.truncated || after.truncated || bounded.truncated,
  };
}

export function extractChildItemResultText(value: unknown): BoundedText {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  const parts: string[] = [];
  let collectedChars = 0;
  let truncated = false;

  while (pending.length > 0 && collectedChars < RESULT_CARRIER_MAX_CHARS) {
    const current = pending.pop();
    if (!current) break;
    if (typeof current.value === "string") {
      const remaining = RESULT_CARRIER_MAX_CHARS - collectedChars;
      const part = current.value.slice(0, remaining);
      parts.push(part);
      collectedChars += part.length;
      truncated ||= part.length < current.value.length;
      continue;
    }
    if (typeof current.value === "number" || typeof current.value === "boolean") {
      const part = String(current.value);
      parts.push(part);
      collectedChars += part.length;
      continue;
    }
    if (!current.value || typeof current.value !== "object") {
      continue;
    }
    if (current.depth >= RESULT_CARRIER_MAX_DEPTH || seen.has(current.value)) {
      truncated = true;
      continue;
    }
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      truncated ||= current.value.length > RESULT_CARRIER_MAX_ITEMS;
      for (
        let index = Math.min(current.value.length, RESULT_CARRIER_MAX_ITEMS) - 1;
        index >= 0;
        index--
      ) {
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    const record = current.value as Record<string, unknown>;
    const carriers = [
      "text",
      "message",
      "content",
      "contentItems",
      "result",
      "output",
      "structuredContent",
    ] as const;
    let foundCarrier = false;
    for (const key of carriers.toReversed()) {
      if (key in record) {
        foundCarrier = true;
        pending.push({ value: record[key], depth: current.depth + 1 });
      }
    }
    truncated ||= !foundCarrier;
  }

  truncated ||= pending.length > 0;
  const result = boundedText(parts.join("\n"), CHILD_ITEM_RENDER_RESULT_MAX_CHARS);
  return {
    ...(result.value ? { value: result.value } : {}),
    truncated: truncated || result.truncated,
  };
}

function serializedBytes(value: ChildItemRenderDetail): number {
  return encoder.encode(JSON.stringify(value)).length;
}

type ShrinkableField = {
  readonly value: string;
  readonly bytes: number;
  readonly update: (value: string | undefined) => void;
};

function enforceSerializedBudget(detail: MutableRenderDetail): ChildItemRenderDetail {
  while (serializedBytes(detail) > CHILD_ITEM_RENDER_JSON_MAX_BYTES) {
    const fields: ShrinkableField[] = [];
    if (detail.command) {
      fields.push({
        value: detail.command,
        bytes: encoder.encode(detail.command).length,
        update: (value) => {
          if (value === undefined) delete detail.command;
          else detail.command = value;
        },
      });
    }
    if (detail.result) {
      fields.push({
        value: detail.result,
        bytes: encoder.encode(detail.result).length,
        update: (value) => {
          if (value === undefined) delete detail.result;
          else detail.result = value;
        },
      });
    }
    for (const file of detail.changedFiles ?? []) {
      if (!file.diff) continue;
      fields.push({
        value: file.diff,
        bytes: encoder.encode(file.diff).length,
        update: (value) => {
          if (value === undefined) delete file.diff;
          else file.diff = value;
        },
      });
    }
    const largest = fields.sort((left, right) => right.bytes - left.bytes)[0];
    if (largest && largest.bytes > 16) {
      const target = Math.max(0, Math.floor(largest.bytes / 2));
      largest.update(truncateUtf8(largest.value, target).value);
    } else if (detail.changedFiles && detail.changedFiles.length > 0) {
      detail.changedFiles = detail.changedFiles.slice(0, -1);
      if (detail.changedFiles.length === 0) delete detail.changedFiles;
    } else {
      delete detail.command;
      delete detail.result;
      break;
    }
    detail.truncated = true;
  }
  return detail;
}

export function makeChildItemRenderDetail(
  input: ChildItemRenderDetailInput,
): ChildItemRenderDetail | undefined {
  const command = boundedText(input.command, CHILD_ITEM_RENDER_COMMAND_MAX_CHARS);
  const result = boundedText(input.result, CHILD_ITEM_RENDER_RESULT_MAX_CHARS);
  let truncated = input.truncated === true || command.truncated || result.truncated;
  const changedFiles: MutableChangedFile[] = [];

  const rawChangedFiles = input.changedFiles ?? [];
  truncated ||= rawChangedFiles.length > CHILD_ITEM_RENDER_CHANGED_FILES_MAX_ITEMS;
  let remainingDiffBytes = CHILD_ITEM_RENDER_DIFF_MAX_CHARS;
  for (
    let index = 0;
    index < Math.min(rawChangedFiles.length, CHILD_ITEM_RENDER_CHANGED_FILES_MAX_ITEMS);
    index++
  ) {
    const rawChange = rawChangedFiles[index];
    if (!rawChange || typeof rawChange !== "object") {
      truncated = true;
      continue;
    }
    const change = rawChange as RawChangedFile;
    const path = safeRelativePath(change.path, input.workspaceRoot);
    truncated ||= path.truncated;
    if (!path.value) continue;
    const rawDiff = changedFileDiff(change);
    const diff = rawDiff.value
      ? truncateUtf8(rawDiff.value, remainingDiffBytes)
      : { truncated: false };
    truncated ||= rawDiff.truncated || diff.truncated;
    if (diff.value) {
      remainingDiffBytes = Math.max(0, remainingDiffBytes - encoder.encode(diff.value).length);
    }
    const kind = normalizeChangeKind(change.kind);
    changedFiles.push({
      path: path.value,
      ...(kind ? { kind } : {}),
      ...(diff.value ? { diff: diff.value } : {}),
    });
  }

  if (!command.value && !result.value && changedFiles.length === 0) {
    return undefined;
  }
  return enforceSerializedBudget({
    ...(command.value ? { command: command.value } : {}),
    ...(result.value ? { result: result.value } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    truncated,
  });
}
