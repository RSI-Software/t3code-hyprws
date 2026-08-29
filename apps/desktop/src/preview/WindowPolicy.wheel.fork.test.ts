import * as NodeEvents from "node:events";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";
import { makeWheelZoomFork } from "./WindowPolicy.wheel.fork.ts";

type WheelListener = (event: Electron.Event, direction: "in" | "out") => Fiber.Fiber<void>;

it.effect("unbinds wheel zoom on guest destruction and preview scope closure", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const zooms: string[] = [];
    const wheel = yield* makeWheelZoomFork((tabId, direction) =>
      Effect.sync(() => {
        zooms.push(`${tabId}:${direction}`);
      }),
    ).pipe(Effect.provideService(Scope.Scope, scope));
    const first = Object.assign(new NodeEvents.EventEmitter(), { isDestroyed: () => false });
    const second = Object.assign(new NodeEvents.EventEmitter(), { isDestroyed: () => false });
    yield* wheel.install("first", first as unknown as Electron.WebContents);
    yield* wheel.install("second", second as unknown as Electron.WebContents);
    const firstWheel = first.listeners("zoom-changed")[0] as WheelListener;
    const secondWheel = second.listeners("zoom-changed")[0] as WheelListener;
    yield* Fiber.join(firstWheel({} as Electron.Event, "in"));
    first.emit("destroyed");
    expect(first.listenerCount("zoom-changed")).toBe(0);
    expect(first.listenerCount("destroyed")).toBe(0);
    yield* Fiber.join(firstWheel({} as Electron.Event, "out"));
    yield* Fiber.join(secondWheel({} as Electron.Event, "out"));
    yield* Scope.close(scope, Exit.void);
    expect(second.listenerCount("zoom-changed")).toBe(0);
    expect(second.listenerCount("destroyed")).toBe(0);
    yield* Fiber.join(secondWheel({} as Electron.Event, "in"));
    expect(zooms).toEqual(["first:in", "second:out"]);
  }),
);
