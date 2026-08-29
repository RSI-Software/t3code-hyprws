import { assert, describe, it } from "@effect/vitest";

import { parseDesktopAgentCommand } from "./dev-desktop-agent.ts";
import {
  allocateDesktopAgentPort,
  desktopAgentInstanceHash,
  desktopAgentPortCandidate,
  resolveAgentTargetWorkspace,
} from "./lib/dev-desktop-agent.ts";

describe("desktop agent launcher", () => {
  it("parses the run, dry-run, url, and help contracts", () => {
    assert.deepStrictEqual(parseDesktopAgentCommand(["run"]), { kind: "run", dryRun: false });
    assert.deepStrictEqual(parseDesktopAgentCommand(["run", "--dry-run"]), {
      kind: "run",
      dryRun: true,
    });
    assert.deepStrictEqual(parseDesktopAgentCommand(["url"]), { kind: "url" });
    assert.deepStrictEqual(parseDesktopAgentCommand(["--help"]), { kind: "help" });
    assert.throws(() => parseDesktopAgentCommand([]), /missing command/u);
    assert.throws(() => parseDesktopAgentCommand(["run", "--wat"]), /unknown argument/u);
  });

  it("targets the numbered workspace immediately before the invoking app", () => {
    assert.deepStrictEqual(resolveAgentTargetWorkspace({ id: 7, name: "7" }), {
      id: 6,
      name: "6",
    });
    assert.throws(
      () => resolveAgentTargetWorkspace({ id: -99, name: "special:scratch" }),
      /numbered Hyprland workspace/u,
    );
    assert.throws(
      () => resolveAgentTargetWorkspace({ id: 4, name: "code" }),
      /numbered Hyprland workspace/u,
    );
    assert.throws(() => resolveAgentTargetWorkspace({ id: 1, name: "1" }), /workspace above 1/u);
  });

  it("derives stable instance hashes and port candidates", () => {
    const hash = desktopAgentInstanceHash("/repo/worktree-a");
    assert.equal(hash, desktopAgentInstanceHash("/repo/worktree-a"));
    assert.notEqual(hash, desktopAgentInstanceHash("/repo/worktree-b"));
    assert.match(hash, /^[0-9a-f]{12}$/u);
    const candidate = desktopAgentPortCandidate(hash);
    assert.isAtLeast(candidate, 9223);
    assert.isBelow(candidate, 9273);
  });

  it("scans past registered and externally bound ports", async () => {
    const checked: number[] = [];
    const port = await allocateDesktopAgentPort({
      hash: "000000abcdef",
      base: 9223,
      spread: 50,
      scanExtra: 5,
      claimedPorts: new Set([9223]),
      isBindable: async (candidate) => {
        checked.push(candidate);
        return candidate >= 9226;
      },
    });

    assert.equal(port, 9226);
    assert.deepStrictEqual(checked, [9224, 9225, 9226]);
  });

  it("fails when the bounded debug-port range is exhausted", async () => {
    let failure: unknown;
    try {
      await allocateDesktopAgentPort({
        hash: "000000abcdef",
        base: 9223,
        spread: 1,
        scanExtra: 1,
        claimedPorts: new Set(),
        isBindable: async () => false,
      });
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, Error);
    assert.match((failure as Error).message, /no free desktop debugging port/u);
  });
});
