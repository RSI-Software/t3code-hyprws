// Fork-owned handlers for the thread ↔ artifact MCP tools, mirroring `../issues/handlers.fork.ts`.
// Each call acts on the requested thread or the caller's own through `ThreadArtifactService`, and
// links with source `agent`.
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadArtifactService from "../../../artifacts/ThreadArtifactService.fork.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ArtifactsToolkitFork, ArtifactThreadRequiredError } from "./tools.fork.ts";

const make = Effect.gen(function* () {
  const artifacts = yield* ThreadArtifactService.ThreadArtifactService;

  /** The requested thread, or the caller's own. */
  const targetThread = Effect.fn("ArtifactsToolkitFork.targetThread")(function* (
    requested: ThreadId | undefined,
  ) {
    // Artifact links are thread metadata like issue and pull request links, so they ride the same
    // pull-requests capability.
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new ArtifactThreadRequiredError();
    }
    return threadId;
  });

  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    link_artifact: writesThread((input) =>
      targetThread(input.threadId).pipe(
        Effect.flatMap((threadId) =>
          artifacts.link({ threadId, path: input.path, title: input.title, source: "agent" }),
        ),
      ),
    ),
    unlink_artifact: writesThread((input) =>
      targetThread(input.threadId).pipe(
        Effect.flatMap((threadId) => artifacts.unlink({ threadId, path: input.path })),
      ),
    ),
    list_thread_artifacts: McpToolAccess.reads((input) =>
      targetThread(input.threadId).pipe(
        Effect.flatMap(artifacts.list),
        Effect.map((links) => ({ artifacts: links })),
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof ArtifactsToolkitFork.tools>;
});

/** Registered on `/mcp` through the marked `thread-artifacts/mcp-artifacts-toolkit` hook. */
export const ArtifactsToolkitHandlersLiveFork = McpToolAccess.toLayer(
  ArtifactsToolkitFork,
  make.pipe(Effect.provide(ThreadArtifactService.layer)),
);
