import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { canShareWithCollaboratorFork } from "./collaboratorShareDialogState.fork";

const fork = EnvironmentId.make("fork");
const stock = EnvironmentId.make("stock");
const configs = new Map([
  [fork, { environment: { capabilities: { collaboratorsFork: true } } }],
  [stock, { environment: { capabilities: {} } }],
]);

vi.mock("~/state/session", () => ({ readEnvironmentScope: () => true }));

describe("canShareWithCollaboratorFork", () => {
  it("offers sharing only where the server serves collaborators", () => {
    expect(canShareWithCollaboratorFork(configs, fork)).toBe(true);
    expect(canShareWithCollaboratorFork(configs, stock)).toBe(false);
  });
});
