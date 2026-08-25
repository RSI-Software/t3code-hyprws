import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useState } from "react";

export type WindowProjectScopeParam = "all";
export type RememberedWindowProjectListScope = "all" | "project";

export type WindowProjectListScope =
  | { readonly kind: "all" }
  | { readonly kind: "project"; readonly projectRef: ScopedProjectRef };

export function windowProjectListScopeStorageKey(projectRef: ScopedProjectRef): string {
  return `t3code:window-project-list-scope:${projectRef.environmentId}:${projectRef.projectId}`;
}

function defaultSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readRememberedListScope(
  projectRef: ScopedProjectRef,
  storage: Pick<Storage, "getItem"> | null = defaultSessionStorage(),
): RememberedWindowProjectListScope | null {
  if (storage === null) return null;
  try {
    const value = storage.getItem(windowProjectListScopeStorageKey(projectRef));
    return value === "all" || value === "project" ? value : null;
  } catch {
    return null;
  }
}

export function writeRememberedListScope(
  projectRef: ScopedProjectRef,
  scope: RememberedWindowProjectListScope,
  storage: Pick<Storage, "setItem"> | null = defaultSessionStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(windowProjectListScopeStorageKey(projectRef), scope);
  } catch {
    // Storage may be denied by the browser. The URL remains authoritative for this navigation.
  }
}

export function resolveListScope(input: {
  readonly forcedProjectRef: ScopedProjectRef | null;
  readonly urlScope: WindowProjectScopeParam | undefined;
  readonly rememberedScope: RememberedWindowProjectListScope | null;
}): WindowProjectListScope {
  if (input.forcedProjectRef === null) return { kind: "all" };
  if (input.urlScope === "all" || input.rememberedScope === "all") return { kind: "all" };
  return { kind: "project", projectRef: input.forcedProjectRef };
}

export function applyWindowProjectScopeChange(input: {
  readonly projectRef: ScopedProjectRef;
  readonly currentScope: WindowProjectListScope["kind"];
  readonly nextScope: RememberedWindowProjectListScope;
  readonly navigate: (urlScope: WindowProjectScopeParam | undefined) => void;
  readonly storage?: Pick<Storage, "setItem"> | null;
}): void {
  if (input.nextScope === input.currentScope) return;
  writeRememberedListScope(input.projectRef, input.nextScope, input.storage);
  input.navigate(input.nextScope === "all" ? "all" : undefined);
}

export interface WindowProjectScopeSearchPatch {
  readonly scope: WindowProjectScopeParam | undefined;
  readonly projectId?: undefined;
}

export function useWindowProjectListScope(
  forcedProjectRef: ScopedProjectRef | null,
  urlScope: WindowProjectScopeParam | undefined,
): {
  readonly listScope: WindowProjectListScope;
  readonly onScopeChange: (
    nextUrlScope: WindowProjectScopeParam | undefined,
    navigate: (patch: WindowProjectScopeSearchPatch) => void,
  ) => void;
} {
  const storageKey =
    forcedProjectRef === null ? null : windowProjectListScopeStorageKey(forcedProjectRef);
  const [rememberedState, setRememberedState] = useState<{
    readonly key: string | null;
    readonly value: RememberedWindowProjectListScope | null;
  }>(() => ({
    key: storageKey,
    value: forcedProjectRef === null ? null : readRememberedListScope(forcedProjectRef),
  }));
  const rememberedScope =
    rememberedState.key === storageKey
      ? rememberedState.value
      : forcedProjectRef === null
        ? null
        : readRememberedListScope(forcedProjectRef);
  const listScope = resolveListScope({ forcedProjectRef, urlScope, rememberedScope });
  const onScopeChange = useCallback(
    (
      nextUrlScope: WindowProjectScopeParam | undefined,
      navigate: (patch: WindowProjectScopeSearchPatch) => void,
    ) => {
      if (forcedProjectRef === null) return;
      const nextScope = nextUrlScope === "all" ? "all" : "project";
      applyWindowProjectScopeChange({
        projectRef: forcedProjectRef,
        currentScope: listScope.kind,
        nextScope,
        navigate: (scope) => {
          setRememberedState({ key: storageKey, value: nextScope });
          navigate({ scope, projectId: undefined });
        },
      });
    },
    [forcedProjectRef, listScope.kind, storageKey],
  );

  return { listScope, onScopeChange };
}
