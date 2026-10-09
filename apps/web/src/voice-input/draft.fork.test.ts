import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../composerDraftStore";
import { commitVoiceDraftFork } from "./draft.fork";

const target = scopeThreadRef(EnvironmentId.make("voice-test"), ThreadId.make("source"));
const other = scopeThreadRef(EnvironmentId.make("voice-test"), ThreadId.make("other"));
const comment = {
  id: "comment-1",
  sectionId: "file:src/app.ts",
  sectionTitle: "File comment",
  filePath: "src/app.ts",
  startIndex: 1,
  endIndex: 2,
  rangeLabel: "L2 to L3",
  text: "Keep this configurable.",
  diff: "@@ -2,2 +2,2 @@\n two\n three",
};

afterEach(() => {
  useComposerDraftStore.getState().clearComposerContent(target);
  useComposerDraftStore.getState().clearComposerContent(other);
});

describe("background voice draft commits", () => {
  it("removes the payload of a chip replaced by transcription without changing another draft", () => {
    const store = useComposerDraftStore.getState();
    store.addReviewComment(target, comment);
    store.setPrompt(other, "other draft");
    commitVoiceDraftFork(target, "spoken replacement");
    expect(store.getComposerDraft(target)?.prompt).toBe("spoken replacement");
    expect(store.getComposerDraft(target)?.reviewComments).toEqual([]);
    expect(store.getComposerDraft(other)?.prompt).toBe("other draft");
  });

  it("retains the payload when its chip remains in the transcribed draft", () => {
    const store = useComposerDraftStore.getState();
    store.addReviewComment(target, comment);
    const prompt = `${store.getComposerDraft(target)!.prompt} spoken addition`;
    commitVoiceDraftFork(target, prompt);
    expect(store.getComposerDraft(target)?.prompt).toBe(prompt);
    expect(store.getComposerDraft(target)?.reviewComments).toEqual([comment]);
  });
});
