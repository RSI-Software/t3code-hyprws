// Fork-owned MCP tools for thread ↔ artifact links, shaped like the issue tools in
// `../issues/tools.fork.ts`. `McpHttpServer.ts` registers them through the marked
// `thread-artifacts/mcp-artifacts-toolkit` hook.
import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ThreadArtifactLink,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
  ProjectService.ProjectService,
];

const ThreadIdInput = Schema.optional(
  ThreadId.annotate({ description: "Thread to act on. Omit for this thread." }),
);

const PathInput = TrimmedNonEmptyString.annotate({
  description: "The file's absolute path, or a path relative to the thread's workspace.",
});

export class ArtifactFileNotFoundError extends Schema.TaggedError<ArtifactFileNotFoundError>()(
  "ArtifactFileNotFoundError",
  { path: Schema.String },
) {
  override get message(): string {
    return `No file at ${this.path}. Write the file first, then link it.`;
  }
}

export class ArtifactNotAFileError extends Schema.TaggedError<ArtifactNotAFileError>()(
  "ArtifactNotAFileError",
  { path: Schema.String },
) {
  override get message(): string {
    return `${this.path} is not a regular file. Link a file, not a directory.`;
  }
}

export class ArtifactWorkspaceUnknownError extends Schema.TaggedError<ArtifactWorkspaceUnknownError>()(
  "ArtifactWorkspaceUnknownError",
  {},
) {
  override get message(): string {
    return "This thread has no workspace to resolve a relative path against. Pass an absolute path.";
  }
}

export class ArtifactThreadRequiredError extends Schema.TaggedError<ArtifactThreadRequiredError>()(
  "ArtifactThreadRequiredError",
  {},
) {
  override get message(): string {
    return "Pass threadId: this MCP client is not running inside a T3 thread.";
  }
}

export class ArtifactThreadNotFoundError extends Schema.TaggedError<ArtifactThreadNotFoundError>()(
  "ArtifactThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ArtifactLinkFailedError extends Schema.TaggedError<ArtifactLinkFailedError>()(
  "ArtifactLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not link the artifact.";
  }
}

export class ArtifactUnlinkFailedError extends Schema.TaggedError<ArtifactUnlinkFailedError>()(
  "ArtifactUnlinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not unlink the artifact.";
  }
}

export class ArtifactListFailedError extends Schema.TaggedError<ArtifactListFailedError>()(
  "ArtifactListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the thread's artifacts.";
  }
}

export const ArtifactToolError = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  ArtifactFileNotFoundError,
  ArtifactNotAFileError,
  ArtifactWorkspaceUnknownError,
  ArtifactThreadRequiredError,
  ArtifactThreadNotFoundError,
  ArtifactLinkFailedError,
  ArtifactUnlinkFailedError,
  ArtifactListFailedError,
]);
export type ArtifactToolError = typeof ArtifactToolError.Type;

export const LinkArtifactInput = Schema.Struct({
  threadId: ThreadIdInput,
  path: PathInput,
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Short label shown beside the thread. Defaults to the file name.",
    }),
  ),
});
export type LinkArtifactInput = typeof LinkArtifactInput.Type;

export const LinkArtifactResult = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  alreadyLinked: Schema.Boolean.annotate({
    description: "True when the file was linked to this thread before the call.",
  }),
});
export type LinkArtifactResult = typeof LinkArtifactResult.Type;

export const UnlinkArtifactResult = Schema.Struct({
  path: Schema.String,
  wasLinked: Schema.Boolean.annotate({
    description: "False when the file was not linked to this thread to begin with.",
  }),
});
export type UnlinkArtifactResult = typeof UnlinkArtifactResult.Type;

export const ListThreadArtifactsResult = Schema.Struct({
  artifacts: Schema.Array(ThreadArtifactLink),
});
export type ListThreadArtifactsResult = typeof ListThreadArtifactsResult.Type;

const LinkArtifactTool = Tool.make("link_artifact", {
  description:
    "Link a document you wrote for the user to keep seeing, such as a tracker, plan, or notes file, so T3 Code shows it beside this thread. Link once after creating the file; later edits show automatically. Linking an already-linked path succeeds with alreadyLinked=true and updates its title.",
  parameters: LinkArtifactInput,
  success: LinkArtifactResult,
  failure: ArtifactToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link artifact to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkArtifactTool = Tool.make("unlink_artifact", {
  description:
    "Remove a document link from this thread; the file itself is untouched. Unlinking a path that is not linked succeeds with wasLinked=false.",
  parameters: Schema.Struct({ threadId: ThreadIdInput, path: PathInput }),
  success: UnlinkArtifactResult,
  failure: ArtifactToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink artifact from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadArtifactsTool = Tool.make("list_thread_artifacts", {
  description:
    "List the documents linked to a thread (omit threadId for this thread), with when each last changed and whether its file is missing.",
  parameters: Schema.Struct({ threadId: ThreadIdInput }),
  success: ListThreadArtifactsResult,
  failure: ArtifactToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread artifacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ArtifactsToolkitFork = Toolkit.make(
  LinkArtifactTool,
  UnlinkArtifactTool,
  ListThreadArtifactsTool,
);
