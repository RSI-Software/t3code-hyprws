import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { linkGitHubIssueHandoffFork } from "../githubIssue/githubIssueHandoff";
import type { MultipleModelTarget } from "./chatViewSend";
import { collectIssueHandoffFork } from "./useMultipleModelSend.fork";

vi.mock("../githubIssue/githubIssueHandoff", () => ({ linkGitHubIssueHandoffFork: vi.fn() }));

it("links only confirmed fanout starts, even when they finish out of order", () => {
  const link = vi.mocked(linkGitHubIssueHandoffFork).mockClear();
  const environmentId = EnvironmentId.make("env");
  const target = (model: string): MultipleModelTarget => ({
    selection: { instanceId: ProviderInstanceId.make("provider"), model },
    text: "work on this issue",
    interactionMode: "default",
  });
  const first = target("a");
  const failed = target("b");
  const last = target("c");
  const handoff = collectIssueHandoffFork("draft", environmentId);
  handoff.capture(first, ThreadId.make("first"));
  handoff.capture(failed, ThreadId.make("failed"));
  handoff.capture(last, ThreadId.make("last"));
  handoff.complete(last, true);
  handoff.complete(failed, false);
  handoff.complete(first, true);
  expect(link).not.toHaveBeenCalled();
  handoff.link();
  expect(link).toHaveBeenCalledExactlyOnceWith("draft", [
    scopeThreadRef(environmentId, ThreadId.make("last")),
    scopeThreadRef(environmentId, ThreadId.make("first")),
  ]);
});
