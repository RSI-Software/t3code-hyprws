import type { ProjectEntry, ProjectListEntriesResult, VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

type VcsDrivers = {
  readonly detect: (
    input: VcsDriverRegistry.VcsDriverResolveInput,
  ) => Effect.Effect<VcsDriverRegistry.VcsDriverHandle | null, VcsError>;
};

/**
 * Fold the VCS ignored-path listing into an indexed workspace listing:
 * every ignored path contributes its implicit parent directories plus a
 * leaf entry marked `ignored`, sorted back into the shared ordering.
 */
function mergeIgnoredWorkspacePaths(
  result: ProjectListEntriesResult,
  ignoredPaths: ReadonlyArray<string>,
  ignoredPathsTruncated: boolean,
): ProjectListEntriesResult {
  const entriesByPath = new Map(result.entries.map((entry) => [entry.path, entry]));
  for (const rawPath of ignoredPaths) {
    const ignoredPath = rawPath.replaceAll("\\", "/").replace(/\/$/, "");
    if (!ignoredPath) continue;

    const segments = ignoredPath.split("/");
    let parentPath = "";
    for (const segment of segments.slice(0, -1)) {
      parentPath = parentPath ? `${parentPath}/${segment}` : segment;
      if (!entriesByPath.has(parentPath)) {
        entriesByPath.set(parentPath, { path: parentPath, kind: "directory", ignored: true });
      }
    }
    if (!entriesByPath.has(ignoredPath)) {
      entriesByPath.set(ignoredPath, { path: ignoredPath, kind: "file", ignored: true });
    }
  }

  const sortedEntries: ProjectEntry[] = [...entriesByPath.values()].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  const entries = sortedEntries.slice(0, WorkspaceSearchIndex.WORKSPACE_INDEX_MAX_ENTRIES);
  return {
    entries,
    truncated: result.truncated || ignoredPathsTruncated || entries.length < sortedEntries.length,
  };
}

/**
 * The fork-only tail of `WorkspaceEntries.list`: when `includeIgnored` is
 * requested, detect a VCS driver, ask it for ignored paths, and merge them
 * into the indexed listing. Every failure path falls back to the plain
 * listing so the shared behaviour never regresses.
 */
export const withIgnoredWorkspaceFiles = Effect.fn("WorkspaceEntries.withIgnoredWorkspaceFiles")(
  function* (options: {
    readonly vcsDrivers: VcsDrivers;
    readonly cwd: string;
    readonly includeIgnored: boolean;
    readonly result: ProjectListEntriesResult;
  }) {
    if (!options.includeIgnored) return options.result;

    const detected = yield* options.vcsDrivers.detect({ cwd: options.cwd }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to detect VCS while listing ignored workspace files", {
          cwd: options.cwd,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    const listIgnoredWorkspaceFiles = detected?.driver.listIgnoredWorkspaceFiles;
    if (!listIgnoredWorkspaceFiles) return options.result;

    const ignoredResult = yield* listIgnoredWorkspaceFiles(options.cwd).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to list ignored workspace files", {
          cwd: options.cwd,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    return ignoredResult
      ? mergeIgnoredWorkspacePaths(options.result, ignoredResult.paths, ignoredResult.truncated)
      : options.result;
  },
);
