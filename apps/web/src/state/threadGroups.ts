import { createThreadGroupEnvironmentAtoms } from "@t3tools/client-runtime/state/thread-groups";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadGroupEnvironment = createThreadGroupEnvironmentAtoms(connectionAtomRuntime);
