import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { bindIgnoredFilesPreferenceFork } from "./ignoredFilesPreference.fork";
import { useDirectoryEntries } from "./useDirectoryEntries";

vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { sessionGenerationAtom: () => Atom.make(0) },
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    listEntries: ({ input }: { input: { includeIgnored: boolean } }) =>
      Atom.make(
        AsyncResult.success({
          entries: [{ path: input.includeIgnored ? "ignored.log" : "visible.ts", kind: "file" }],
          truncated: false,
        }),
      ),
  },
}));

it("refetches directory listings in both directions when the existing client preference changes", async () => {
  let includeIgnored = false;
  const listeners = new Set<() => void>();
  bindIgnoredFilesPreferenceFork({
    getSnapshot: () => includeIgnored,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  function Probe() {
    const directory = useDirectoryEntries(EnvironmentId.make("ignored-files"), "/repo");
    return <output>{directory.entries.map((entry) => entry.path).join(",")}</output>;
  }
  // A query probe with no navigation.
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <Probe />
    </RegistryContext.Provider>,
    { router: false },
  );
  await expect.element(screen.getByText("visible.ts")).toBeInTheDocument();
  await act(() => {
    includeIgnored = true;
    for (const listener of listeners) listener();
  });
  await expect.element(screen.getByText("ignored.log")).toBeInTheDocument();
  await act(() => {
    includeIgnored = false;
    for (const listener of listeners) listener();
  });
  await expect.element(screen.getByText("visible.ts")).toBeInTheDocument();
});
