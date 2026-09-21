import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as HyprlandPlacement from "./HyprlandPlacement.ts";
import type { HyprlandWindowRuleGrammar } from "./hyprland.ts";
import type { WindowId } from "./WindowId.fork.ts";
import {
  holdWindowTitleFork,
  placeAtMapFork,
  resolveMapPlacementFork,
} from "./WindowPlacement.fork.ts";

const PID = 4242;
const windowId = "00000000-0000-4000-8000-000000000021" as WindowId;

type ClaimOutcome = "claimed" | "timeout" | "interrupt";

/**
 * A compositor that keeps every rule and Lua global a payload installs, so a
 * test can see what outlives a placement.
 */
function makeCompositor(grammar: HyprlandWindowRuleGrammar, outcome: ClaimOutcome) {
  const live = new Set<string>();
  const counters = new Map<string, number>();
  const names: string[] = [];
  let installed = 0;
  let markClaiming = () => {};
  const claiming = new Promise<void>((resolve) => (markClaiming = resolve));
  const request = async (_environment: unknown, payload: string): Promise<string> => {
    await Promise.resolve();
    if (payload === "j/version")
      return JSON.stringify({ version: grammar === "lua" ? "0.56.2" : "0.54.1" });
    if (payload === "j/status") return JSON.stringify({ configProvider: "lua" });
    if (payload === "j/clients") {
      markClaiming();
      if (outcome === "interrupt") return new Promise<string>(() => {});
      if (outcome === "timeout") return "[]";
      const title = `t3code-window-${windowId}`;
      return JSON.stringify([{ address: "0xa", pid: PID, title, workspace: { id: 1, name: "1" } }]);
    }
    const keyword = /^\/keyword windowrule (\S+) (.*), (match:.*)$/u.exec(payload);
    if (keyword !== null) {
      const rule = `${keyword[1]}|${keyword[3]}`;
      if (keyword[2] === "unset") live.delete(rule);
      else {
        live.add(rule);
        installed += 1;
      }
      return "ok";
    }
    const lua = /^\/eval local key=("[^"]*");/u.exec(payload);
    if (lua !== null) {
      const key = JSON.parse(lua[1] ?? '""') as string;
      if (payload.includes("hl.window_rule(")) {
        const counter = /local seqkey=("[^"]*");/u.exec(payload);
        const seqkey =
          counter === null ? `${key}.sequence` : (JSON.parse(counter[1] ?? '""') as string);
        const seq = (counters.get(seqkey) ?? 0) + 1;
        counters.set(seqkey, seq);
        const prefix = /name=("[^"]*")\.\.seq/u.exec(payload)?.[1];
        names.push(`${JSON.parse(prefix ?? '""') as string}${seq}`);
        live.add(key);
        live.add(seqkey);
        installed += 1;
      }
      if (payload.includes("rawset(_G,key,nil)")) live.delete(key);
    }
    return "ok";
  };
  return { live, names, installed: () => installed, claiming, request };
}

const fakeWindow = () =>
  ({
    isDestroyed: () => false,
    showInactive: () => {},
    setTitle: () => {},
  }) as unknown as Electron.BrowserWindow;

const place = (compositor: ReturnType<typeof makeCompositor>, outcome: ClaimOutcome) =>
  Effect.gen(function* () {
    const hyprlandPlacement = yield* HyprlandPlacement.make({
      environment: { instanceSignature: "test", runtimeDirectory: "/run/user/1000" },
      pid: PID,
      claimAttempts: 1,
      claimIntervalMs: 0,
      requestHyprland: compositor.request,
    });
    const placement = resolveMapPlacementFork({
      hyprlandAvailable: true,
      windowId,
      devAgent: Option.none(),
      restoredWorkspace: { id: 4, name: "4" },
    });
    assert.isNotNull(placement);
    if (placement === null) return;
    const window = fakeWindow();
    const fiber = yield* Effect.forkChild(
      placeAtMapFork({
        hyprlandPlacement,
        window,
        windowId,
        placement,
        titleHold: holdWindowTitleFork(window, placement.title, "T3 Code"),
        dismissSplash: Effect.void,
      }),
    );
    if (outcome === "interrupt") {
      yield* Effect.promise(() => compositor.claiming);
      yield* Fiber.interrupt(fiber);
    } else {
      yield* Fiber.join(fiber);
    }
  });

describe("placeAtMapFork", () => {
  it.live.each(
    (["lua", "legacy"] as const).flatMap((grammar) =>
      (["claimed", "timeout", "interrupt"] as const).map((outcome) => ({ grammar, outcome })),
    ),
  )(
    "removes every rule a restored window's claim installs ($grammar, $outcome)",
    ({ grammar, outcome }) =>
      Effect.gen(function* () {
        const compositor = makeCompositor(grammar, outcome);
        yield* place(compositor, outcome);
        assert.isAbove(compositor.installed(), 0, "the placement staged a rule");
        // Only the one compositor-wide rule counter outlives a placement.
        assert.deepEqual([...compositor.live], grammar === "lua" ? ["t3code.rule.sequence"] : []);
      }),
  );

  it.live("names each Lua rule afresh when the same window is restored again", () =>
    Effect.gen(function* () {
      const compositor = makeCompositor("lua", "claimed");
      yield* place(compositor, "claimed");
      yield* place(compositor, "claimed");
      assert.lengthOf(compositor.names, 4);
      assert.lengthOf(new Set(compositor.names), 4, "no rule name is reused");
    }),
  );
});
