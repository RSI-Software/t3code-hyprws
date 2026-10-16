import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

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
  useEnvironmentScope: () => true,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("./projectFilesQueryState", () => ({
  confirmProjectFileQueryData: () => true,
  getOptimisticProjectFileQueryData: () => null,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: vi.fn(),
}));
vi.mock("./MarkdownRichEditor", () => ({ MarkdownRichEditor: state.ChangeSource }));

import { RichMarkdownPreviewBoundary } from "./RichMarkdownPreviewBoundary";

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  state.onChange = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("autosaves while Rich stays mounted after StrictMode effect replay", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockResolvedValue(AsyncResult.success(undefined));
  const environmentId = EnvironmentId.make("rich-save-regression");
  await act(async () => {
    root = createRoot(document.createElement("div"));
    root.render(
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
          children={null}
        />
      </StrictMode>,
    );
  });
  // The boundary lazy-loads the editor; wait for it to mount before driving it.
  await vi.waitFor(() => expect(state.onChange).not.toBeNull());
  vi.useFakeTimers();
  state.onChange!("# Edited\n");
  await vi.advanceTimersByTimeAsync(499);
  expect(writeFile).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(writeFile).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { cwd: "/workspace", relativePath: "README.md", contents: "# Edited\n" },
  });
});
