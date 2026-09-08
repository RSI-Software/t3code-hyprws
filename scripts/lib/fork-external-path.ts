// @effect-diagnostics nodeBuiltinImport:off - Operator evidence stays outside the checkout.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const externalPath = (root: string, path: string): string => {
  const resolved = NodePath.resolve(path);
  const relative = NodePath.relative(NodeFS.realpathSync(root), NodePath.dirname(resolved));
  if (relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..")) {
    throw new Error(`report must be outside the repository: ${resolved}`);
  }
  return resolved;
};
