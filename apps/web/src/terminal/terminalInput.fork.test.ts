import { expect, it, vi } from "vite-plus/test";
import { writeToRunningTerminalFork } from "./terminalInput.fork";

it("ignores input to a failed pane while forwarding running-pane input", () => {
  const write = vi.fn(() => Promise.resolve());
  expect(writeToRunningTerminalFork("error", write)).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
  writeToRunningTerminalFork("running", write);
  expect(write).toHaveBeenCalledOnce();
});
