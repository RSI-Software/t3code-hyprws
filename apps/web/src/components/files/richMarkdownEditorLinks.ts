import type { MarkdownFileLinkMeta } from "~/markdown-links";
import { resolveMarkdownFileLinkMeta } from "~/markdown-links";
import {
  formatFilePathPosition,
  splitFilePathPosition,
} from "@t3tools/client-runtime/markdown-links";
import { formatWorkspaceRelativePath } from "~/filePathDisplay";

function normalizeDotSegments(path: string): string {
  const slashPath = path.replaceAll("\\", "/");
  const usesBackslashes = path.includes("\\");
  const isUnc = slashPath.startsWith("//");
  const isPosixAbsolute = !isUnc && slashPath.startsWith("/");
  const hasTrailingSeparator = /[/\\]$/.test(path);
  const parts = slashPath.split("/").filter(Boolean);
  const rootDepth = isUnc ? Math.min(2, parts.length) : /^[A-Za-z]:$/.test(parts[0] ?? "") ? 1 : 0;
  const normalized: string[] = [];

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (normalized.length > rootDepth && normalized.at(-1) !== "..") normalized.pop();
      else if (!isUnc && !isPosixAbsolute && rootDepth === 0) normalized.push(part);
      continue;
    }
    normalized.push(part);
  }

  const prefix = isUnc ? "//" : isPosixAbsolute ? "/" : "";
  const normalizedPath = `${prefix}${normalized.join("/")}`;
  const withTrailingSeparator =
    hasTrailingSeparator && normalizedPath !== prefix ? `${normalizedPath}/` : normalizedPath;
  return usesBackslashes ? withTrailingSeparator.replaceAll("/", "\\") : withTrailingSeparator;
}

/**
 * Rich-editor links are resolved from the document directory. Normalize the
 * resulting dot segments here instead of changing the shared upstream link
 * resolver used by chat, previews, terminals, and remote environments.
 */
export function resolveRichMarkdownEditorLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const resolved = resolveMarkdownFileLinkMeta(href, cwd, baseDir);
  if (!resolved) return null;

  const { path: rawPath, line, column } = splitFilePathPosition(resolved.targetPath);
  const path = normalizeDotSegments(rawPath);
  if (path === rawPath) return resolved;

  const targetPath = formatFilePathPosition({
    path,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  });
  // Let the shared resolver derive basename, position, display, and workspace
  // membership from the normalized target instead of duplicating that metadata
  // logic in this fork adapter. The fallback only covers unusual resolved paths
  // that the shared candidate classifier does not accept a second time.
  return (
    resolveMarkdownFileLinkMeta(targetPath, cwd) ?? {
      ...resolved,
      filePath: path,
      targetPath,
      displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    }
  );
}
