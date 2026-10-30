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
      | ArtifactLinkFailedError
    >;
    readonly unlink: (input: {
      readonly threadId: ThreadId;
      readonly path: string;
    }) => Effect.Effect<
      { readonly path: string; readonly wasLinked: boolean },
      ArtifactThreadNotFoundError | ArtifactWorkspaceUnknownError | ArtifactUnlinkFailedError
    >;
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<
      ReadonlyArray<ThreadArtifactLink>,
      ArtifactThreadNotFoundError | ArtifactListFailedError
    >;
  }
>()("t3/artifacts/ThreadArtifactService.fork/ThreadArtifactService") {}

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

  /** `fail` wraps a read failure in the calling operation's error. */
  const requireThread = Effect.fn("ThreadArtifactService.requireThread")(function* <E>(
    threadId: ThreadId,
    fail: (cause: unknown) => E,
  ) {
    const thread = yield* engine.getThreadShell(threadId).pipe(Effect.mapError(fail));
    if (thread === null || thread.deletedAt !== null) {
      return yield* new ArtifactThreadNotFoundError({ threadId });
    }
    return thread;
  });

  /** An absolute, normalized path; a relative one resolves against the thread's workspace. */
  const resolvePath = Effect.fn("ThreadArtifactService.resolvePath")(function* <E>(
    thread: OrchestrationV2ThreadShell,
    input: string,
    fail: (cause: unknown) => E,
  ) {
    if (path.isAbsolute(input)) return path.resolve(input);
    const workspace =
      thread.worktreePath ??
      (yield* projects.getShell(thread.projectId).pipe(
        Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
        Effect.mapError(fail),
      ));
    if (workspace === undefined) {
      return yield* new ArtifactWorkspaceUnknownError();
    }
    return path.resolve(workspace, input);
  });

  const isLinked = (thread: OrchestrationV2ThreadShell, target: string) =>
    (thread.artifacts ?? []).some((link) => link.path === target);

  return ThreadArtifactService.of({
    link: Effect.fn("ThreadArtifactService.link")(function* (input) {
      const fail = (cause: unknown) => new ArtifactLinkFailedError({ cause });
      const thread = yield* requireThread(input.threadId, fail);
      const target = yield* resolvePath(thread, input.path, fail);
      // Touching a network path makes Windows sign in to its host with the user's NTLM credentials.
      if (isNetworkPath(input.path) || isNetworkPath(target)) {
        return yield* new ArtifactNetworkPathError({ path: target });
      }
      const info = yield* fs
        .stat(target)
        .pipe(
          Effect.mapError((cause) =>
            cause.reason._tag === "NotFound"
              ? new ArtifactFileNotFoundError({ path: target, cause })
              : fail(cause),
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
        .pipe(Effect.mapError(fail));
      return { path: target, title, alreadyLinked: isLinked(thread, target) };
    }),
    unlink: Effect.fn("ThreadArtifactService.unlink")(function* (input) {
      const fail = (cause: unknown) => new ArtifactUnlinkFailedError({ cause });
      const thread = yield* requireThread(input.threadId, fail);
      const target = yield* resolvePath(thread, input.path, fail);
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
        .pipe(Effect.mapError(fail));
      return { path: target, wasLinked: true };
    }),
    list: Effect.fn("ThreadArtifactService.list")(function* (threadId) {
      const thread = yield* requireThread(
        threadId,
        (cause) => new ArtifactListFailedError({ cause }),
      );
      return thread.artifacts ?? [];
    }),
  });
});

export const layer = Layer.effect(ThreadArtifactService, make);
