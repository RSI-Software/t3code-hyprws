// Fork-owned MCP tools for thread ↔ GitHub issue links
// (RSI-Software/t3code-hyprws#1433), shaped like upstream's pull request
// toolkit in `../pullRequests/tools.ts`. `McpHttpServer.ts` registers them
// through the marked `github-issues/mcp-issues-toolkit` hook.
import {
  GitHubIssueState,
  McpCapabilityUnavailableError,
  PositiveInt,
  ThreadIssueLinkSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  Orchestrator.OrchestratorV2,
  ProjectService.ProjectService,
];

const LINK_EVERY_ISSUE =
  "Link every GitHub issue you work on for this thread as soon as you start on it.";

/**
 * Either the issue's URL or its repository and number, like the pull request
 * target: both resolve to the same host-level identity.
 */
export const IssueTargetInput = Schema.Struct({
  url: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The issue's web URL, for example https://github.com/owner/repo/issues/123. Preferred when you have it; host, repository and number are read from it.",
    }),
  ),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Repository path below the host, for example owner/repo. Required with number when url is omitted.",
    }),
  ),
  number: Schema.optional(
    PositiveInt.annotate({
      description: "Issue number. Required with repository when url is omitted.",
    }),
  ),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "GitHub host the repository lives on, for example github.com. Defaults to the host of this thread's project when that project is on GitHub.",
    }),
  ),
});
export type IssueTargetInput = typeof IssueTargetInput.Type;

export class IssueUrlInvalidError extends Schema.TaggedError<IssueUrlInvalidError>()(
  "IssueUrlInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a recognised GitHub issue URL. Pass repository and number instead.";
  }
}

export class IssueTargetIncompleteError extends Schema.TaggedError<IssueTargetIncompleteError>()(
  "IssueTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "Pass either url, or both repository and number.";
  }
}

export class IssueHostRequiredError extends Schema.TaggedError<IssueHostRequiredError>()(
  "IssueHostRequiredError",
  {},
) {
  override get message(): string {
    return "This thread's project has no GitHub remote. Pass host or url.";
  }
}

export class IssueThreadNotFoundError extends Schema.TaggedError<IssueThreadNotFoundError>()(
  "IssueThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class IssueLinkFailedError extends Schema.TaggedError<IssueLinkFailedError>()(
  "IssueLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not link the issue.";
  }
}

export class IssueUnlinkFailedError extends Schema.TaggedError<IssueUnlinkFailedError>()(
  "IssueUnlinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not unlink the issue.";
  }
}

export class IssueListFailedError extends Schema.TaggedError<IssueListFailedError>()(
  "IssueListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the thread's issues.";
  }
}

export const IssueToolError = Schema.Union([
  McpCapabilityUnavailableError,
  IssueUrlInvalidError,
  IssueTargetIncompleteError,
  IssueHostRequiredError,
  IssueThreadNotFoundError,
  IssueLinkFailedError,
  IssueUnlinkFailedError,
  IssueListFailedError,
]);
export type IssueToolError = typeof IssueToolError.Type;

const IssueIdentity = {
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
};

export const LinkIssueResult = Schema.Struct({
  ...IssueIdentity,
  url: Schema.String,
  alreadyLinked: Schema.Boolean.annotate({
    description: "True when the issue was linked to this thread before the call.",
  }),
});
export type LinkIssueResult = typeof LinkIssueResult.Type;

export const UnlinkIssueResult = Schema.Struct({
  ...IssueIdentity,
  wasLinked: Schema.Boolean.annotate({
    description: "False when the issue was not linked to this thread to begin with.",
  }),
});
export type UnlinkIssueResult = typeof UnlinkIssueResult.Type;

export const ThreadIssueEntry = Schema.Struct({
  ...IssueIdentity,
  url: Schema.String,
  source: ThreadIssueLinkSource,
  /** Null until T3 Code has read the issue from GitHub; never a guess. */
  state: Schema.NullOr(GitHubIssueState),
  title: Schema.NullOr(Schema.String),
});
export type ThreadIssueEntry = typeof ThreadIssueEntry.Type;

export const ListThreadIssuesResult = Schema.Struct({
  issues: Schema.Array(ThreadIssueEntry),
});
export type ListThreadIssuesResult = typeof ListThreadIssuesResult.Type;

const LinkIssueTool = Tool.make("link_issue", {
  description: `${LINK_EVERY_ISSUE} Links a GitHub issue to this thread so T3 Code shows it beside the thread and the thread beside the issue. Pass the URL, or repository plus number. Linking an already-linked issue succeeds with alreadyLinked=true.`,
  parameters: IssueTargetInput,
  success: LinkIssueResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link issue to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkIssueTool = Tool.make("unlink_issue", {
  description:
    "Remove a GitHub issue link from this thread, for example after linking the wrong issue. Pass the URL, or repository plus number. Unlinking an issue that is not linked succeeds with wasLinked=false.",
  parameters: IssueTargetInput,
  success: UnlinkIssueResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink issue from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadIssuesTool = Tool.make("list_thread_issues", {
  description: `List the GitHub issues linked to this thread with their last known state. ${LINK_EVERY_ISSUE}`,
  success: ListThreadIssuesResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const IssuesToolkitFork = Toolkit.make(LinkIssueTool, UnlinkIssueTool, ListThreadIssuesTool);
