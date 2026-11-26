import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("an agent's project update marks and unmarks a team project", () =>
  Effect.gen(function* () {
    const marks: Array<boolean | undefined> = [];
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "Claude Code", access: "full-access" },
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ServerSettings.ServerSettingsService)({}),
      Layer.mock(Project.ProjectService)({
        update: (input) =>
          Effect.sync(() => marks.push(input.teamFork)).pipe(
            Effect.andThen(
              Effect.fail(
                new Project.ProjectInvalidError({
                  projectId: input.projectId,
                  detail: "Recorded.",
                }),
              ),
            ),
          ),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    for (const teamFork of [true, false]) {
      yield* toolkit
        .handle("t3_project_update", { projectId: ProjectId.make("project-1"), teamFork })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    }

    expect(marks).toEqual([true, false]);
  }),
);
