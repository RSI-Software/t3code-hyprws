import { EnvironmentId, type ProjectListEntriesResult } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  requests: [] as {
    query: { input: { cwd: string; includeIgnored?: boolean } };
    signal: AbortSignal;
    resolve: (value: unknown) => void;
  }[],
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: (
    _registry: unknown,
    query: { input: { cwd: string; includeIgnored?: boolean } },
    { signal }: { signal: AbortSignal },
  ) => new Promise((resolve) => mocks.requests.push({ query, signal, resolve })),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { refresh: () => {} } }));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { listEntries: (query: unknown) => query },
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { sessionGenerationAtom: () => ({}) },
}));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("@effect/atom-react", () => ({ useAtomMount: () => {}, useAtomSubscribe: () => {} }));
vi.mock("../../state/query", () => {
  const data: ProjectListEntriesResult = {
    entries: [{ kind: "directory", path: "src" }],
    truncated: false,
  };
  const state = {
    data,
    error: null,
    failure: null,
    isPending: false,
    successResult: { timestamp: 1 },
    refresh: () => {},
  };
  return { useEnvironmentQuery: () => state };
});

import { useFileTreeEntries } from "./useFileTreeEntries";

it("invalidates cached workspaces and aborts stale directory reads when ignored visibility changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.requests = [];
  const root = createRoot(document.createElement("div"));
  let tree!: ReturnType<typeof useFileTreeEntries>;
  const environmentId = EnvironmentId.make("ignored-cache");
  function Surface({ cwd, includeIgnored }: { cwd: string; includeIgnored: boolean }) {
    const current = useFileTreeEntries({ cwd, environmentId, includeIgnored, searchQuery: "" });
    useLayoutEffect(() => {
      tree = current;
    });
    return null;
  }
  const show = (cwd: string, includeIgnored: boolean) =>
    act(() => root.render(<Surface cwd={cwd} includeIgnored={includeIgnored} />));
  try {
    await show("/first", false);
    let first: Promise<void> | undefined;
    await act(() => {
      first = tree.loadDirectory("src");
    });
    const initial = mocks.requests.at(-1)!;
    expect(initial.query.input.includeIgnored).toBe(false);
    await act(async () => {
      initial.resolve({
        _tag: "Success",
        value: { entries: [{ kind: "file", path: "src/one.ts" }], truncated: false },
        timestamp: 2,
      });
      await first;
    });
    await act(() => {
      tree.selectPath("src/one.ts");
      tree.setExpandedPaths(() => new Set(["src"]));
    });
    await show("/second", false);
    let pending: Promise<void> | undefined;
    await act(() => {
      pending = tree.loadDirectory("src");
    });
    const stale = mocks.requests.at(-1)!;
    await show("/second", true);
    expect(stale.signal.aborted).toBe(true);
    await act(async () => {
      stale.resolve({
        _tag: "Success",
        value: { entries: [{ kind: "file", path: "src/stale.ts" }], truncated: false },
        timestamp: 3,
      });
      await pending;
    });
    expect(tree.loadedDirectories.size).toBe(0);
    expect(tree.entries.map((entry) => entry.path)).toEqual(["src"]);
    await show("/first", true);
    expect(tree.loadedDirectories.size).toBe(0);
    expect(tree.selectedPath).toBe("src/one.ts");
    expect(tree.expandedPaths.has("src")).toBe(true);
    let visible: Promise<void> | undefined;
    await act(() => {
      visible = tree.loadDirectory("src");
    });
    const refreshed = mocks.requests.at(-1)!;
    expect(refreshed.query.input).toMatchObject({ cwd: "/first", includeIgnored: true });
    await act(async () => {
      refreshed.resolve({
        _tag: "Success",
        value: { entries: [{ kind: "file", path: "src/ignored.log" }], truncated: false },
        timestamp: 4,
      });
      await visible;
    });
    expect(tree.entries.some((entry) => entry.path === "src/ignored.log")).toBe(true);
    await show("/first", false);
    expect(tree.loadedDirectories.size).toBe(0);
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
