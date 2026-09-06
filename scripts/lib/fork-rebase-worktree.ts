// @effect-diagnostics nodeBuiltinImport:off - This standalone Git helper runs before an Effect runtime exists.
// Reuses one checkout's pnpm install from a detached Git worktree.
// Workspace-relative links must be copied verbatim so they resolve to the
// rebased sources, while the root package store can be shared directly.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const copyModuleLinks = (source: string, destination: string): void => {
  NodeFS.mkdirSync(destination, { recursive: true });
  for (const entry of NodeFS.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = NodePath.join(source, entry.name);
    const destinationPath = NodePath.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      NodeFS.symlinkSync(NodeFS.readlinkSync(sourcePath), destinationPath);
    } else if (entry.isDirectory()) {
      copyModuleLinks(sourcePath, destinationPath);
    } else {
      NodeFS.copyFileSync(sourcePath, destinationPath);
    }
  }
};

export const linkInstalledModules = (root: string, worktree: string): void => {
  const visit = (directory: string, depth: number): void => {
    const relative = NodePath.relative(root, directory);
    const sourceModules = NodePath.join(directory, "node_modules");
    const worktreeModules = NodePath.join(worktree, relative, "node_modules");
    if (NodeFS.existsSync(sourceModules) && !NodeFS.existsSync(worktreeModules)) {
      if (relative.length === 0) NodeFS.symlinkSync(sourceModules, worktreeModules, "dir");
      else copyModuleLinks(sourceModules, worktreeModules);
    }
    if (depth === 2) return;
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".repos" ||
        entry.name === ".t3"
      ) {
        continue;
      }
      visit(NodePath.join(directory, entry.name), depth + 1);
    }
  };
  visit(root, 0);
};
