// Fork-owned handlers for the thread ↔ artifact MCP tools, mirroring `../issues/handlers.fork.ts`.
// Each call acts on the requested thread or the caller's own and links with source `agent`. T3
// stores links only: a link checks that the file exists, and nothing here writes or deletes files.
import { CommandId, type OrchestrationV2ThreadShell, type ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  ArtifactFileNotFoundError,
  ArtifactLinkFailedError,
  ArtifactListFailedError,
  ArtifactNotAFileError,
  ArtifactsToolkitFork,
  ArtifactThreadNotFoundError,
  ArtifactThreadRequiredError,
  ArtifactUnlinkFailedError,
  ArtifactWorkspaceUnknownError,
} from "./tools.fork.ts";

type Failure =
  | typeof ArtifactLinkFailedError
  | typeof ArtifactUnlinkFailedError
  | typeof ArtifactListFailedError;

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const requireThread = Effect.fn("ArtifactsToolkitFork.requireThread")(function* (
    Failure: Failure,
    requested: ThreadId | undefined,
  ) {
    // Artifact links are thread metadata like issue and pull request links, so they ride the same
    // pull-requests capability.
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new ArtifactThreadRequiredError();
    }
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (thread === null || thread.deletedAt !== null) {
      return yield* new ArtifactThreadNotFoundError({ threadId });
    }
    return thread;
  });

  /** An absolute, normalized path; a relative one resolves against the thread's workspace. */
  const resolvePath = Effect.fn("ArtifactsToolkitFork.resolvePath")(function* (
    thread: OrchestrationV2ThreadShell,
    input: string,
    Failure: typeof ArtifactLinkFailedError | typeof ArtifactUnlinkFailedError,
  ) {
    if (path.isAbsolute(input)) return path.resolve(input);
    const workspace =
      thread.worktreePath ??
      (yield* projects.getShell(thread.projectId).pipe(
        Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
        Effect.mapError((cause) => new Failure({ cause })),
      ));
    if (workspace === undefined) {
      return yield* new ArtifactWorkspaceUnknownError();
    }
    return path.resolve(workspace, input);
  });

  const isLinked = (thread: OrchestrationV2ThreadShell, target: string) =>
    (thread.artifacts ?? []).some((link) => link.path === target);

  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    link_artifact: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(ArtifactLinkFailedError, input.threadId);
        const target = yield* resolvePath(thread, input.path, ArtifactLinkFailedError);
        const info = yield* fs
          .stat(target)
          .pipe(
            Effect.mapError((cause) =>
              cause.reason._tag === "NotFound"
                ? new ArtifactFileNotFoundError({ path: target })
                : new ArtifactLinkFailedError({ cause }),
            ),
          );
        if (info.type !== "File") {
          return yield* new ArtifactNotAFileError({ path: target });
        }
        const title = input.title ?? path.basename(target);
        yield* engine
          .dispatch({
            type: "thread.artifact.link",
            commandId: yield* commandId("mcp-artifact-link", thread.id),
            threadId: thread.id,
            path: target,
            title,
            source: "agent",
          })
          .pipe(Effect.mapError((cause) => new ArtifactLinkFailedError({ cause })));
        return { path: target, title, alreadyLinked: isLinked(thread, target) };
      }),
    ),
    unlink_artifact: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(ArtifactUnlinkFailedError, input.threadId);
        const target = yield* resolvePath(thread, input.path, ArtifactUnlinkFailedError);
        if (!isLinked(thread, target)) {
          return { path: target, wasLinked: false };
        }
        yield* engine
          .dispatch({
            type: "thread.artifact.unlink",
            commandId: yield* commandId("mcp-artifact-unlink", thread.id),
            threadId: thread.id,
            path: target,
          })
          .pipe(Effect.mapError((cause) => new ArtifactUnlinkFailedError({ cause })));
        return { path: target, wasLinked: true };
      }),
    ),
    list_thread_artifacts: McpToolAccess.reads((input) =>
      requireThread(ArtifactListFailedError, input.threadId).pipe(
        Effect.map((thread) => ({ artifacts: thread.artifacts ?? [] })),
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof ArtifactsToolkitFork.tools>;
});

/** Registered on `/mcp` through the marked `thread-artifacts/mcp-artifacts-toolkit` hook. */
export const ArtifactsToolkitHandlersLiveFork = McpToolAccess.toLayer(ArtifactsToolkitFork, make);
