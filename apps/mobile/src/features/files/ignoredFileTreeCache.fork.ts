import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";

export function ignoredFileTreeVisibilityFork(includeIgnored: boolean | undefined) {
  return includeIgnored === undefined ? {} : { includeIgnored };
}

type Selection = {
  expandedPaths: Set<string>;
  selectedPath: string | null;
  revealedSelection: { path: string | null; ancestors: Set<string> };
};
type Cache<D> = { key: string; workspaces: Map<string, D> };

export function useIgnoredFileTreeCacheFork<D extends Selection>(
  includeIgnored: boolean | undefined,
  setCache: Dispatch<SetStateAction<Cache<D>>>,
  createDirectories: () => D,
): void {
  const previous = useRef(includeIgnored);
  // oxlint-disable-next-line t3code/react-effect-budget -- visibility changes invalidate external listing targets before consumers load children.
  useLayoutEffect(() => {
    if (previous.current === includeIgnored) return;
    previous.current = includeIgnored;
    setCache((current) => ({
      ...current,
      workspaces: new Map(
        [...current.workspaces].map(([key, directories]) => [
          key,
          {
            ...createDirectories(),
            expandedPaths: directories.expandedPaths,
            selectedPath: directories.selectedPath,
            revealedSelection: directories.revealedSelection,
          },
        ]),
      ),
    }));
  }, [includeIgnored, setCache, createDirectories]);
}
