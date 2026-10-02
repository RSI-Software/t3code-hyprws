import { createAgentActivityEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentActivityEnvironment = createAgentActivityEnvironmentAtoms(connectionAtomRuntime);
