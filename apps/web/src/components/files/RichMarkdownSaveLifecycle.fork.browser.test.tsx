import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { StrictMode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, render } from "../../../test/render";

const state = vi.hoisted(() => {
  const state = {
    writeFile: vi.fn(),
    onChange: null as ((contents: string) => void) | null,
    ChangeSource: (props: { onChange: (contents: string) => void }) => {
      state.onChange = props.onChange;
      return null;
    },
  };
  return state;
});
const { writeFile } = state;
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: () => true,
  sessionHasScope: () => true,
  environmentSession: { sessionStateAtom: () => Atom.make(null) },
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original()),
  runAtomCommand: (...args: unknown[]) => writeFile(args[2]),
}));
vi.mock("./projectFilesQueryState", () => ({
  clearProjectFileQueryData: vi.fn(),
  confirmProjectFileQueryData: () => true,
  getProjectFileQueryAtom: vi.fn(),
  optimisticFileAtom: () => ({}),
  getOptimisticProjectFileQueryData: () => null,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: vi.fn(),
}));
vi.mock("./MarkdownRichEditor", () => ({ MarkdownRichEditor: state.ChangeSource }));

import { RichMarkdownPreviewBoundary } from "./RichMarkdownPreviewBoundary";

it("autosaves while Rich stays mounted after StrictMode effect replay", async () => {
  writeFile.mockResolvedValue(AsyncResult.success(undefined));
  const environmentId = EnvironmentId.make("rich-save-regression");
  await using _screen = await render(
    <StrictMode>
      <RichMarkdownPreviewBoundary
        enabled
        environmentId={environmentId}
        cwd="/workspace"
        relativePath="README.md"
        contents="# Initial\n"
        theme="dark"
        wordWrap
        onOpenFile={vi.fn()}
        onPendingChange={vi.fn()}
      >
        {null}
      </RichMarkdownPreviewBoundary>
    </StrictMode>,
    { router: false },
  );
  // The boundary lazy-loads the editor; wait for it to mount before driving it.
  await vi.waitFor(() => expect(state.onChange).not.toBeNull());
  using _timers = fakeTimers();
  state.onChange!("# Edited\n");
  await vi.advanceTimersByTimeAsync(499);
  expect(writeFile).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(writeFile).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { cwd: "/workspace", relativePath: "README.md", contents: "# Edited\n" },
  });
});
