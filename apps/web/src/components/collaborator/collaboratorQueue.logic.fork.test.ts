import { expect, it } from "vite-plus/test";

import { queuedLineLockedFork, queuedLineOwnedFork } from "./collaboratorQueue.logic.fork";

it("locks a collaborator's queued line, never the host's own or an unshared one", () => {
  expect(queuedLineLockedFork({ collaboratorFork: { name: "Alex", text: "Ship it?" } })).toBe(true);
  expect(
    queuedLineLockedFork({ collaboratorFork: { name: "Jordan", text: "Not yet.", host: true } }),
  ).toBe(false);
  expect(queuedLineLockedFork({})).toBe(false);
  expect(queuedLineLockedFork(undefined)).toBe(false);
});

it("gives a collaborator only the queued lines they signed, whatever the name on them", () => {
  const line = (name: string, subject?: string) => ({
    collaboratorFork: { name, text: "Ship it?", ...(subject ? { subject } : {}) },
  });
  expect(queuedLineOwnedFork(line("Alex", "colleague:alex-1"), "colleague:alex-1")).toBe(true);
  expect(queuedLineOwnedFork(line("Alex's laptop", "colleague:alex-1"), "colleague:alex-1")).toBe(
    true,
  );
  expect(queuedLineOwnedFork(line("Alex", "colleague:alex-2"), "colleague:alex-1")).toBe(false);
  expect(queuedLineOwnedFork(line("Alex"), "colleague:alex-1")).toBe(false);
  expect(queuedLineOwnedFork(undefined, "colleague:alex-1")).toBe(false);
});
