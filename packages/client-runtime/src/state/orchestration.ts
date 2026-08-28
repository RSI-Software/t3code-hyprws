import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { AgentActivityLoader, type AgentActivityRequest } from "./agentActivityHttp.ts";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";

export {
  AgentActivityLoader,
  agentActivityLoaderLayer,
  type AgentActivityRequest,
} from "./agentActivityHttp.ts";

export class AgentActivityConnectionNotReadyError extends Data.TaggedError(
  "AgentActivityConnectionNotReadyError",
)<{ readonly message: string }> {}

const loadAgentActivity = (input: AgentActivityRequest) =>
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const loader = yield* AgentActivityLoader;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return yield* new AgentActivityConnectionNotReadyError({
        message: "The environment HTTP connection is not ready.",
      });
    }
    return yield* loader.load(prepared.value, input);
  });

export function createAgentActivityEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | AgentActivityLoader | R, E>,
) {
  const agentActivity = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:agent-activity",
    staleTimeMs: 0,
    idleTtlMs: 60_000,
    execute: loadAgentActivity,
  });
  return {
    agentActivity: Object.assign(agentActivity, {
      load: createEnvironmentCommand(runtime, {
        label: "environment-command:orchestration:agent-activity-load",
        execute: loadAgentActivity,
      }),
    }),
  };
}

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
  };
}
