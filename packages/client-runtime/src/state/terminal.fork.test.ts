import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { createTerminalSession } from "./terminal.ts";
import { EMPTY_TERMINAL_BUFFER_STATE, type TerminalBufferState } from "./terminalSession.ts";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");

// The server keys a terminal session by attachment, so every command the
// session driver sends must name the attachment it attached with.
it("sends the attached input's attachment with resize, initial input, reopen, and close", () => {
  const registry = AtomRegistry.make({ scheduleTask: () => () => {} });
  const attachment = Atom.make<AsyncResult.AsyncResult<TerminalBufferState, unknown>>(
    AsyncResult.initial(true),
  );
  const calls: Array<{ readonly command: string; readonly input: unknown }> = [];
  const command = (name: string) => ({
    label: name,
    run: async (_registry: AtomRegistry.AtomRegistry, value: { readonly input: unknown }) => {
      calls.push({ command: name, input: value.input });
      return AsyncResult.success(undefined);
    },
  });
  const session = createTerminalSession(
    {
      attach: () => attachment,
      observe: () => Atom.make(AsyncResult.initial(true)),
      open: command("open"),
      resize: command("resize"),
      write: command("write"),
      close: command("close"),
    },
    {
      target: { environmentId, threadId, terminalId: "term-1" },
      gridSize: { cols: 120, rows: 40 },
      initialInput: "ls\n",
      canOperate: () => true,
      onExit: () => {},
    },
  );
  registry.mount(
    session.driver({
      kind: "attached",
      input: {
        threadId,
        terminalId: "term-1",
        attachmentId: "device-1",
        cwd: "/repo",
        cols: 80,
        rows: 24,
      },
    }),
  );
  const emit = (state: Partial<TerminalBufferState>) =>
    registry.set(attachment, AsyncResult.success({ ...EMPTY_TERMINAL_BUFFER_STATE, ...state }));

  emit({ status: "exited", version: 1 });
  emit({ status: "running", version: 2 });
  emit({ status: "exited", version: 3 });

  expect(calls.map((call) => call.command).toSorted()).toEqual([
    "close",
    "open",
    "resize",
    "write",
  ]);
  for (const call of calls) expect(call.input).toMatchObject({ attachmentId: "device-1" });
});
