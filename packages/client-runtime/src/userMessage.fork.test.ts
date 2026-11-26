import { describe, expect, it } from "vite-plus/test";

import { collaboratorPresentationFork } from "./userMessage.fork.ts";

describe("collaboratorPresentationFork", () => {
  it("shows a collaborator by name and the host's own message as the host's", () => {
    expect(
      collaboratorPresentationFork({ collaboratorFork: { name: "Alex", text: "Hi" } }),
    ).toEqual({ text: "Hi", attribution: "guest", scheduledTaskId: undefined, guestName: "Alex" });
    expect(
      collaboratorPresentationFork({
        collaboratorFork: { name: "Jordan", text: "Hi", host: true },
      }),
    ).toEqual({ text: "Hi", attribution: null, scheduledTaskId: undefined });
  });
});
