import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ workflow: null as unknown }));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadProjection: (() => ({ projection: { messages: [] } })) as never,
}));

import "~/index.css";

import { render } from "../../../test/render";
import { QueuedRunsControl } from "./QueuedRunsControl";

it("lets the host edit their own queued line in a shared thread, not a collaborator's", async () => {
  state.workflow = {
    activeRun: null,
    queuedRuns: [
      ["run:alex", { name: "Alex", text: "Ship it?" }],
      ["run:host", { name: "Jordan", text: "Not yet.", host: true }],
    ].map(([runId, collaboratorFork]) => ({
      run: { id: runId, userMessageId: `${runId}:message` },
      text: (collaboratorFork as { text: string }).text,
      attachments: [],
      context: { version: 1, records: [], collaboratorFork },
    })),
  };
  const onEditQueuedRun = vi.fn();
  await using _screen = await render(
    <QueuedRunsControl
      environmentId={"environment:test" as never}
      threadId={"thread:test" as never}
      optimisticMessages={[]}
      editingRunId={null}
      editBlockedReason={null}
      onEditQueuedRun={onEditQueuedRun}
      onCancelEdit={() => undefined}
      timestampFormat="locale"
      onOpenThread={() => undefined}
      onImageExpand={() => undefined}
    />,
  );

  const edit = page.getByRole("button", { name: "Edit queued message", exact: true });
  await expect.element(edit.nth(0)).toBeDisabled();
  await expect.element(edit.nth(1)).toBeEnabled();
  await edit.nth(1).click();
  expect(onEditQueuedRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ runId: "run:host", text: "Not yet." }),
  );
});
