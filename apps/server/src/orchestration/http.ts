import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ORCHESTRATION_AGENT_ACTIVITY_DEFAULT_LIMIT,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { projectAgentActivitySnapshot } from "./AgentActivityProjection.ts";
import { isAgentActivityPageCursorFor } from "./agentActivityCursor.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { generateThreadGroupTitle } from "./ThreadGroupTitles.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "agentActivity",
        Effect.fn("environment.orchestration.agentActivity")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          if (
            args.payload.beforeCursor !== undefined &&
            !isAgentActivityPageCursorFor(
              args.payload.beforeCursor,
              args.params.threadId,
              args.params.agentId,
            )
          ) {
            return yield* failEnvironmentInvalidRequest("invalid_agent_activity_cursor");
          }
          const snapshot = yield* projectionSnapshotQuery
            .getAgentActivitySnapshot(args.params.threadId, args.params.agentId, {
              limit: args.payload.limit ?? ORCHESTRATION_AGENT_ACTIVITY_DEFAULT_LIMIT,
              ...(args.payload.beforeCursor === undefined
                ? {}
                : { beforeCursor: args.payload.beforeCursor }),
            })
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_agent_activity_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("agent_not_found");
          }
          return projectAgentActivitySnapshot(snapshot.value);
        }),
      )
      .handle(
        "generateThreadGroupTitle",
        Effect.fn("environment.orchestration.generateThreadGroupTitle")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
          const textGeneration = yield* Effect.serviceOption(TextGeneration);
          if (Option.isNone(serverSettings) || Option.isNone(textGeneration)) {
            return yield* failEnvironmentInternal(
              "thread_group_title_generation_failed",
              new Error("Thread group title generation is unavailable."),
            );
          }
          const snapshot = yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("thread_group_title_generation_failed", cause),
              ),
            );
          const project = snapshot.projects.find((entry) => entry.id === args.payload.projectId);
          if (!project) return yield* failEnvironmentNotFound("project_not_found");
          const settings = yield* serverSettings.value.getSettings.pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("thread_group_title_generation_failed", cause),
            ),
          );
          return yield* generateThreadGroupTitle(textGeneration.value, {
            cwd: project.workspaceRoot,
            memberTitles: args.payload.memberTitles,
            ...(args.payload.previousTitle === undefined
              ? {}
              : { previousTitle: args.payload.previousTitle }),
            modelSelection: settings.textGenerationModelSelection,
          }).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("thread_group_title_generation_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          return yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
            Effect.tapError(() =>
              cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
        }),
      );
  }),
);
