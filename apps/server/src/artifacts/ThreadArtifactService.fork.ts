// Fork-owned (thread-artifacts): links, unlinks and lists a thread's artifacts. T3 stores links
// only: a link checks that the file exists, and nothing here writes or deletes files.
import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type ThreadArtifactLink,
  type ThreadArtifactLinkSource,
  type ThreadId,
} from "@t3tools/contracts";
import { isNetworkPath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";

export class ArtifactFileNotFoundError extends Schema.TaggedError<ArtifactFileNotFoundError>()(
  "ArtifactFileNotFoundError",
  { path: Schema.String, cause: Schema.Defect() },
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

export class ArtifactNetworkPathError extends Schema.TaggedError<ArtifactNetworkPathError>()(
  "ArtifactNetworkPathError",
  { path: Schema.String },
) {
  override get message(): string {
    return `${this.path} is a network path. Link a file on this machine.`;
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

export class ArtifactThreadNotFoundError extends Schema.TaggedError<ArtifactThreadNotFoundError>()(
  "ArtifactThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ArtifactOperationFailedError extends Schema.TaggedError<ArtifactOperationFailedError>()(
  "ArtifactOperationFailedError",
  {
    operation: Schema.Literals(["link", "unlink", "list"]),
    stage: Schema.Literals(["read-thread", "read-project", "stat", "dispatch"]),
    threadId: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the artifact: ${this.stage} failed.`;
  }
}

export class ThreadArtifactService extends Context.Service<
  ThreadArtifactService,
  {
    /** Links an existing file, or relinks it with a new title. */
    readonly link: (input: {
      readonly threadId: ThreadId;
      readonly path: string;
      readonly title?: string | undefined;
      readonly source: ThreadArtifactLinkSource;
    }) => Effect.Effect<
      { readonly path: string; readonly title: string; readonly alreadyLinked: boolean },
      | ArtifactThreadNotFoundError
      | ArtifactWorkspaceUnknownError
      | ArtifactNetworkPathError
      | ArtifactFileNotFoundError
      | ArtifactNotAFileError
      | ArtifactOperationFailedError
    >;
    readonly unlink: (input: {
      readonly threadId: ThreadId;
      readonly path: string;
    }) => Effect.Effect<
      { readonly path: string; readonly wasLinked: boolean },
      ArtifactThreadNotFoundError | ArtifactWorkspaceUnknownError | ArtifactOperationFailedError
    >;
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<
      ReadonlyArray<ThreadArtifactLink>,
      ArtifactThreadNotFoundError | ArtifactOperationFailedError
    >;
  }
>()("t3/artifacts/ThreadArtifactService.fork/ThreadArtifactService") {}

type Operation = ArtifactOperationFailedError["operation"];

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

  const requireThread = Effect.fn("ThreadArtifactService.requireThread")(function* (
    operation: Operation,
    threadId: ThreadId,
  ) {
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ArtifactOperationFailedError({ operation, stage: "read-thread", threadId, cause }),
        ),
      );
    if (thread === null || thread.deletedAt !== null) {
      return yield* new ArtifactThreadNotFoundError({ threadId });
    }
    return thread;
  });

  /** An absolute, normalized path; a relative one resolves against the thread's workspace. */
  const resolvePath = Effect.fn("ThreadArtifactService.resolvePath")(function* (
    operation: Operation,
    thread: OrchestrationV2ThreadShell,
    input: string,
  ) {
    if (path.isAbsolute(input)) return path.resolve(input);
    const workspace =
      thread.worktreePath ??
      (yield* projects.getShell(thread.projectId).pipe(
        Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
        Effect.mapError(
          (cause) =>
            new ArtifactOperationFailedError({
              operation,
              stage: "read-project",
              threadId: thread.id,
              path: input,
              cause,
            }),
        ),
      ));
    if (workspace === undefined) {
      return yield* new ArtifactWorkspaceUnknownError();
    }
    return path.resolve(workspace, input);
  });

  const dispatchFailed =
    (operation: Operation, threadId: ThreadId, target: string) => (cause: unknown) =>
      new ArtifactOperationFailedError({
        operation,
        stage: "dispatch",
        threadId,
        path: target,
        cause,
      });

  const isLinked = (thread: OrchestrationV2ThreadShell, target: string) =>
    (thread.artifacts ?? []).some((link) => link.path === target);

  return ThreadArtifactService.of({
    link: Effect.fn("ThreadArtifactService.link")(function* (input) {
      const thread = yield* requireThread("link", input.threadId);
      const target = yield* resolvePath("link", thread, input.path);
      // Touching a network path makes Windows sign in to its host with the user's NTLM credentials.
      if (isNetworkPath(input.path) || isNetworkPath(target)) {
        return yield* new ArtifactNetworkPathError({ path: target });
      }
      const info = yield* fs.stat(target).pipe(
        Effect.mapError((cause) =>
          cause.reason._tag === "NotFound"
            ? new ArtifactFileNotFoundError({ path: target, cause })
            : new ArtifactOperationFailedError({
                operation: "link",
                stage: "stat",
                threadId: thread.id,
                path: target,
                cause,
              }),
        ),
      );
      if (info.type !== "File") {
        return yield* new ArtifactNotAFileError({ path: target });
      }
      const title = input.title ?? path.basename(target);
      yield* engine
        .dispatch({
          type: "thread.artifact.link",
          commandId: yield* commandId("artifact-link", thread.id),
          threadId: thread.id,
          path: target,
          title,
          source: input.source,
        })
        .pipe(Effect.mapError(dispatchFailed("link", thread.id, target)));
      return { path: target, title, alreadyLinked: isLinked(thread, target) };
    }),
    unlink: Effect.fn("ThreadArtifactService.unlink")(function* (input) {
      const thread = yield* requireThread("unlink", input.threadId);
      const target = yield* resolvePath("unlink", thread, input.path);
      if (!isLinked(thread, target)) {
        return { path: target, wasLinked: false };
      }
      yield* engine
        .dispatch({
          type: "thread.artifact.unlink",
          commandId: yield* commandId("artifact-unlink", thread.id),
          threadId: thread.id,
          path: target,
        })
        .pipe(Effect.mapError(dispatchFailed("unlink", thread.id, target)));
      return { path: target, wasLinked: true };
    }),
    list: Effect.fn("ThreadArtifactService.list")(function* (threadId) {
      const thread = yield* requireThread("list", threadId);
      return thread.artifacts ?? [];
    }),
  });
});

export const layer = Layer.effect(ThreadArtifactService, make);
