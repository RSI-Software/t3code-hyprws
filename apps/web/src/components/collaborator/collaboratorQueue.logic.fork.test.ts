import { expect, it } from "vite-plus/test";

import { queuedLineLockedFork } from "./collaboratorQueue.logic.fork";

it("locks a collaborator's queued line, never the host's own or an unshared one", () => {
  expect(queuedLineLockedFork({ collaboratorFork: { name: "Alex", text: "Ship it?" } })).toBe(true);
  expect(
    queuedLineLockedFork({ collaboratorFork: { name: "Jordan", text: "Not yet.", host: true } }),
  ).toBe(false);
  expect(queuedLineLockedFork({})).toBe(false);
  expect(queuedLineLockedFork(undefined)).toBe(false);
});
