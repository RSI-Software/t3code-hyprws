import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

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
      <AssistantCitationHighlights viewport={viewport} draftTarget={draftTarget} />
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
