import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, GitHubIssueDetail, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  CopyIcon,
  LinkIcon,
  MessageCircleQuestionIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { readLocalApi } from "../../localApi";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  appendGitHubIssuePrompt,
  githubIssueAskPrompt,
  githubIssueExplainPrompt,
} from "./githubIssueAsk.logic";

type AskKind = "ask" | "explain";

/**
 * The pull request panel's overflow menu, for an issue: refresh, the two questions an agent can
 * answer without touching code, and the ways to take the issue elsewhere. "Work on this issue"
 * stays the header's one button because it is the action the panel exists for.
 */
export function GitHubIssueActionsMenu({
  environmentId,
  detail,
  composerTarget,
  refreshing,
  onRefresh,
  copyLinkShortcut,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: GitHubIssueDetail;
  /** The thread the panel sits beside: questions land in its composer rather than a new thread. */
  readonly composerTarget: ScopedThreadRef | null;
  readonly refreshing: boolean;
  readonly onRefresh: (() => void) | undefined;
  /** Whether the copy-link shortcut copies this issue here; beside a thread it copies the thread. */
  readonly copyLinkShortcut: boolean;
}) {
  const newThread = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [asking, setAsking] = useState<AskKind | null>(null);
  const { copyToClipboard } = useCopyToClipboard<string>({
    target: "issue reference",
    onCopy: (label) => toastManager.add({ type: "success", title: `${label} copied` }),
    onError: (error, label) =>
      toastManager.add({
        type: "error",
        title: `Failed to copy ${label}`,
        description: error.message,
      }),
  });

  const ask = async (kind: AskKind) => {
    if (asking !== null) return;
    const prompt = kind === "ask" ? githubIssueAskPrompt(detail) : githubIssueExplainPrompt(detail);
    const nextStep = kind === "ask" ? "type your question, then send." : "read it over, then send.";
    const store = useComposerDraftStore.getState();
    if (composerTarget !== null) {
      appendGitHubIssuePrompt(composerTarget, prompt, store);
      toastManager.add({
        type: "success",
        title: "Added to the composer",
        description: `The issue is in this thread's composer: ${nextStep}`,
      });
      return;
    }
    setAsking(kind);
    const opened = await newThread(scopeProjectRef(environmentId, detail.projectId)).then(
      (result) => result,
      () => null,
    );
    setAsking(null);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    appendGitHubIssuePrompt(opened.draftId, prompt, store);
    toastManager.add({
      type: "success",
      title: "Asked in a thread",
      description: `The issue is in the composer: ${nextStep}`,
    });
  };

  const label = refreshing ? "Refreshing issue" : "More issue actions";
  return (
    <TooltipProvider>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={<Button aria-label={label} size="icon-xs" variant="ghost-muted" />}
              >
                {/* The refresh lives in this menu, so while one runs the trigger wears the
                    spinning glyph in place of the dots, as the pull request panel's does. */}
                {refreshing ? (
                  <RefreshIcon refreshing size="md" />
                ) : (
                  <MoreHorizontalIcon className="size-4" />
                )}
              </MenuTrigger>
            }
          />
          <TooltipPopup>{label}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="bottom">
          {onRefresh ? (
            <MenuItem disabled={refreshing} onClick={onRefresh}>
              <RefreshIcon size="sm" refreshing={refreshing} />
              Refresh
            </MenuItem>
          ) : null}
          <MenuItem disabled={asking !== null} onClick={() => void ask("ask")}>
            <MessageCircleQuestionIcon className="mt-1 size-3.5 shrink-0 self-start" />
            <span className="flex min-w-0 flex-col">
              <span>{asking === "ask" ? "Opening..." : "Ask a question"}</span>
              <span className="text-xs text-muted-foreground">
                {composerTarget !== null
                  ? "Adds the issue to this thread's composer."
                  : "Opens a thread that knows which issue you mean."}
              </span>
            </span>
          </MenuItem>
          <MenuItem disabled={asking !== null} onClick={() => void ask("explain")}>
            <BookOpenIcon className="mt-1 size-3.5 shrink-0 self-start" />
            <span className="flex min-w-0 flex-col">
              <span>{asking === "explain" ? "Opening..." : "Explain this issue"}</span>
              <span className="text-xs text-muted-foreground">
                What it asks for and where it lands in the code.
              </span>
            </span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}>
            <ArrowUpRightIcon className="size-3.5" />
            Open on GitHub
          </MenuItem>
          <MenuItem onClick={() => copyToClipboard(detail.url, "Issue link")}>
            <LinkIcon className="size-3.5" />
            Copy link
            {copyLinkShortcut ? (
              <MenuShortcut>
                {shortcutLabelForCommand(keybindings, "thread.copyReference")}
              </MenuShortcut>
            ) : null}
          </MenuItem>
          <MenuItem onClick={() => copyToClipboard(`#${detail.number}`, "Issue number")}>
            <CopyIcon className="size-3.5" />
            Copy issue number
          </MenuItem>
        </MenuPopup>
      </Menu>
    </TooltipProvider>
  );
}
