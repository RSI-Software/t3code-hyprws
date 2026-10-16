import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const { writeFile } = vi.hoisted(() => ({ writeFile: vi.fn() }));
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
vi.mock("./MarkdownRichEditor", () => ({ MarkdownRichEditor: ChangeSource }));

import { RichMarkdownPreviewBoundary } from "./RichMarkdownPreviewBoundary";

function ChangeSource(_props: { onChange: (contents: string) => void }) {
  return null;
}

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("autosaves while Rich stays mounted after StrictMode effect replay", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockResolvedValue(AsyncResult.success(undefined));
  const environmentId = EnvironmentId.make("rich-save-regression");
  await act(async () => {
    renderer = create(
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
  renderer!.root.findByType(ChangeSource).props.onChange("# Edited\n");
  await vi.advanceTimersByTimeAsync(499);
  expect(writeFile).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(writeFile).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { cwd: "/workspace", relativePath: "README.md", contents: "# Edited\n" },
  });
});
