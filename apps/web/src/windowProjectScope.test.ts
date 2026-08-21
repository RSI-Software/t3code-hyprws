import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  readRememberedListScope,
  resolveListScope,
  windowProjectListScopeStorageKey,
  writeRememberedListScope,
  useWindowProjectListScope,
} from "./windowProjectScope";

const projectA = scopeProjectRef("environment-a" as never, "project-a" as never);
const projectB = scopeProjectRef("environment-b" as never, "project-a" as never);
const projectC = scopeProjectRef("environment-a" as never, "project-c" as never);

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("resolveListScope", () => {
  it("always resolves the hub to all projects", () => {
    expect(
      resolveListScope({ forcedProjectRef: null, urlScope: undefined, rememberedScope: "project" }),
    ).toEqual({ kind: "all" });
  });

  it("defaults a project window to its forced project", () => {
    expect(
      resolveListScope({
        forcedProjectRef: projectA,
        urlScope: undefined,
        rememberedScope: null,
      }),
    ).toEqual({ kind: "project", projectRef: projectA });
  });

  it("lets an explicit all-projects URL override remembered project scope", () => {
    expect(
      resolveListScope({
        forcedProjectRef: projectA,
        urlScope: "all",
        rememberedScope: "project",
      }),
    ).toEqual({ kind: "all" });
  });

  it("uses valid remembered scope and narrows on invalid storage", () => {
    expect(
      resolveListScope({
        forcedProjectRef: projectA,
        urlScope: undefined,
        rememberedScope: "all",
      }),
    ).toEqual({ kind: "all" });
    expect(
      resolveListScope({
        forcedProjectRef: projectA,
        urlScope: undefined,
        rememberedScope: "project",
      }),
    ).toEqual({ kind: "project", projectRef: projectA });
  });
});

describe("useWindowProjectListScope", () => {
  it("resolves forced scope and produces project-route search cleanup", () => {
    const captured: { current?: ReturnType<typeof useWindowProjectListScope> } = {};
    function Probe() {
      captured.current = useWindowProjectListScope(projectA, "all");
      return null;
    }

    renderToStaticMarkup(createElement(Probe));
    const hookResult = captured.current;
    expect(hookResult?.listScope).toEqual({ kind: "all" });
    if (hookResult === undefined) throw new Error("scope hook was not rendered");

    const patches: Array<{ readonly scope: "all" | undefined; readonly projectId?: undefined }> =
      [];
    hookResult.onScopeChange(undefined, (patch) => patches.push(patch));
    expect(patches).toEqual([{ scope: undefined, projectId: undefined }]);
  });
});

describe("window project list scope storage", () => {
  it("keys remembered scope by both environment and project", () => {
    const storage = memoryStorage();
    writeRememberedListScope(projectA, "all", storage);
    writeRememberedListScope(projectB, "project", storage);
    writeRememberedListScope(projectC, "all", storage);

    expect(readRememberedListScope(projectA, storage)).toBe("all");
    expect(readRememberedListScope(projectB, storage)).toBe("project");
    expect(readRememberedListScope(projectC, storage)).toBe("all");
    expect(windowProjectListScopeStorageKey(projectA)).not.toBe(
      windowProjectListScopeStorageKey(projectB),
    );
    expect(windowProjectListScopeStorageKey(projectA)).not.toBe(
      windowProjectListScopeStorageKey(projectC),
    );
  });

  it("treats invalid and denied storage as absent", () => {
    const invalid = { getItem: () => "widen" };
    const deniedRead = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
    };
    const deniedWrite = {
      setItem: (): void => {
        throw new Error("denied");
      },
    };

    expect(readRememberedListScope(projectA, invalid)).toBeNull();
    expect(readRememberedListScope(projectA, deniedRead)).toBeNull();
    expect(() => writeRememberedListScope(projectA, "all", deniedWrite)).not.toThrow();
  });
});
