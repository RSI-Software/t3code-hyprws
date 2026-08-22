import type { Dispatch, ReactElement, SetStateAction } from "react";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  handleNewThread: vi.fn(),
  projectRef: { environmentId: "env-1", projectId: "project-1" },
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let effects: Array<() => void> = [];
  let slots: unknown[] = [];

  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
      effects = [];
    },
    reset() {
      cursor = 0;
      effects = [];
      slots = [];
    },
    flushEffects() {
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    },
    useEffect(effect: () => void) {
      nextIndex();
      effects.push(effect);
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] = initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({
    ...options,
    useParams: () => testState.projectRef,
  }),
}));

vi.mock("../components/DraftStartError", () => ({
  DraftStartError: "draft-start-error",
}));

vi.mock("../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => testState.handleNewThread,
}));

import {
  ProjectIndexRouteContent,
  ProjectIndexRouteView,
} from "./project.$environmentId.$projectId.index";

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProjectIndexRouteView", () => {
  beforeEach(() => {
    hooks.reset();
    testState.handleNewThread.mockReset();
  });

  it("renders the shared retry affordance when draft start fails", async () => {
    testState.handleNewThread.mockRejectedValue(new Error("environment unavailable"));

    hooks.beginRender();
    const initial = ProjectIndexRouteView() as ReactElement<{ readonly failed: boolean }>;
    expect(initial.props.failed).toBe(false);
    hooks.flushEffects();
    await flushPromises();

    hooks.beginRender();
    const failed = ProjectIndexRouteView() as ReactElement<{
      readonly failed: boolean;
      readonly onRetry: () => void;
    }>;
    const content = ProjectIndexRouteContent(failed.props);

    expect(failed.props.failed).toBe(true);
    expect(isValidElement(content) && content.type).toBe("draft-start-error");
    expect(testState.handleNewThread).toHaveBeenCalledWith(testState.projectRef, { replace: true });

    failed.props.onRetry();
    hooks.beginRender();
    const retrying = ProjectIndexRouteView() as ReactElement<{ readonly failed: boolean }>;
    expect(retrying.props.failed).toBe(false);
    hooks.flushEffects();
    expect(testState.handleNewThread).toHaveBeenCalledTimes(2);
  });
});
