import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { AssistantCitationHighlights } from "./AssistantCitationHighlights";

const HIGHLIGHT = "t3-assistant-citation-draft";
const draftTarget = DraftId.make("citation-highlights");
const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: " world",
};

function Timeline({ sourceKey }: { sourceKey: string }) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <div ref={setViewport} data-assistant-citation-viewport="">
      <p
        key={sourceKey}
        data-assistant-citation-source={citation.messageId}
        data-assistant-citation-environment={citation.environmentId}
        data-assistant-citation-thread={citation.threadId}
      >
        hello world
      </p>
      <AssistantCitationHighlights
        viewport={viewport}
        draftTarget={draftTarget}
        onEditComment={() => false}
        onRemove={() => false}
      />
    </div>
  );
}

const paintedRanges = () => [...(CSS.highlights.get(HIGHLIGHT) ?? [])] as Range[];
const setPrompt = (prompt: string) =>
  act(() => useComposerDraftStore.getState().setPrompt(draftTarget, prompt));

it("tints a draft citation, follows its source remounting, and clears when it leaves", async () => {
  await setPrompt(`See ${serializeAssistantCitation(citation)} `);
  await using screen = await render(<Timeline sourceKey="first" />);

  await vi.waitFor(() => expect(paintedRanges().map(String)).toEqual(["hello"]));
  const [firstRange] = paintedRanges();

  await screen.rerender(<Timeline sourceKey="second" />);
  await vi.waitFor(() => {
    const [range] = paintedRanges();
    expect(range).not.toBe(firstRange);
    expect(range?.startContainer.isConnected).toBe(true);
  });

  await setPrompt("See ");
  await vi.waitFor(() => expect(CSS.highlights.has(HIGHLIGHT)).toBe(false));

  await setPrompt(`See ${serializeAssistantCitation(citation)} `);
  await vi.waitFor(() => expect(paintedRanges()).toHaveLength(1));
  await screen.unmount();
  expect(CSS.highlights.has(HIGHLIGHT)).toBe(false);
  await setPrompt("");
});

/** Moves the pointer onto the end of the painted range showing `text`. */
const hover = (ranges: ReadonlyArray<Range>, text: string) => {
  const rect = ranges.find((range) => String(range) === text)!.getBoundingClientRect();
  document.querySelector("[data-assistant-citation-source]")!.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      pointerType: "mouse",
      clientX: rect.right - 2,
      clientY: rect.top + rect.height / 2,
    }),
  );
};

it("previews the innermost of two overlapping citations under the pointer", async () => {
  const whole = withAssistantCitationComment(
    { ...citation, text: "hello world", end: 11, suffix: "" },
    "On the line",
  );
  const inner = withAssistantCitationComment(citation, "On hello");
  await setPrompt(`${serializeAssistantCitation(whole)} ${serializeAssistantCitation(inner)} `);
  await using _screen = await render(<Timeline sourceKey="overlap" />);

  await vi.waitFor(() => expect(paintedRanges()).toHaveLength(2));
  hover(paintedRanges(), "hello");
  await expect.element(page.getByText("On hello", { exact: true })).toBeVisible();
  hover(paintedRanges(), "hello world");
  await expect.element(page.getByText("On the line", { exact: true })).toBeVisible();
  await setPrompt("");
});

it("pops the new badge when a passage the draft already cites is cited again", async () => {
  const cite = serializeAssistantCitation(citation);
  await setPrompt(`${cite} `);
  await using _screen = await render(<Timeline sourceKey="pops" />);
  const fresh = () =>
    [...document.querySelectorAll("[data-citation-markers] > span")].map((marker) =>
      marker.hasAttribute("data-fresh"),
    );
  await vi.waitFor(() => expect(fresh()).toEqual([false]));

  await setPrompt(`${cite} ${cite} `);
  await vi.waitFor(() => expect(fresh()).toEqual([false, true]));
  await setPrompt("");
});
