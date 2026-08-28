import {
  AuthOrchestrationOperateScope,
  type ModelSelection,
  type ThreadGroupTitleGenerationInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type { ProjectStoreV2 } from "./ProjectStore.ts";

// The thread-title prompt titles whatever the user asked for, so an
// instruction here becomes the title ("Name Sidebar Thread Group"). Each
// member title stands in as one user request, in the USER-section shape of
// regenerated thread contents, so the group is titled by their shared subject.
function buildThreadGroupTitleMessage(memberTitles: readonly string[]): string {
  return memberTitles.map((title) => `USER:\n${title}`).join("\n\n");
}

export function generateThreadGroupTitle(
  textGeneration: TextGeneration["Service"],
  input: {
    readonly cwd: string;
    readonly memberTitles: readonly string[];
    readonly previousTitle?: string | undefined;
    readonly modelSelection: ModelSelection;
  },
) {
  return textGeneration.generateThreadTitle({
    cwd: input.cwd,
    message: buildThreadGroupTitleMessage(input.memberTitles),
    ...(input.previousTitle === undefined ? {} : { previousTitle: input.previousTitle }),
    modelSelection: input.modelSelection,
  });
}

const failTitleGeneration = (cause: unknown) =>
  failEnvironmentInternal("thread_group_title_generation_failed", cause);

/**
 * The `generateThreadGroupTitle` HTTP handler: titles a sidebar group in the
 * project's workspace with the configured text-generation model. A missing
 * project answers as a generation failure; the contract has no
 * `project_not_found` reason since the fork's not-found extension retired.
 */
export const makeThreadGroupTitleHandlerFork = (projectStore: ProjectStoreV2["Service"]) =>
  Effect.fn("environment.orchestration.generateThreadGroupTitle")(function* (args: {
    readonly endpoint: { readonly name: string };
    readonly payload: ThreadGroupTitleGenerationInput;
  }) {
    yield* annotateEnvironmentRequest(args.endpoint.name);
    yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
    const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
    const textGeneration = yield* Effect.serviceOption(TextGeneration);
    if (Option.isNone(serverSettings) || Option.isNone(textGeneration)) {
      return yield* failTitleGeneration(new Error("Thread group title generation is unavailable."));
    }
    const project = yield* projectStore
      .getShell(args.payload.projectId)
      .pipe(Effect.catch(failTitleGeneration));
    if (Option.isNone(project)) {
      return yield* failTitleGeneration(new Error(`Project ${args.payload.projectId} not found.`));
    }
    const settings = yield* serverSettings.value.getSettings.pipe(
      Effect.catch(failTitleGeneration),
    );
    return yield* generateThreadGroupTitle(textGeneration.value, {
      cwd: project.value.workspaceRoot,
      memberTitles: args.payload.memberTitles,
      previousTitle: args.payload.previousTitle,
      modelSelection: settings.textGenerationModelSelection,
    }).pipe(Effect.catch(failTitleGeneration));
  });
