import * as Layer from "effect/Layer";
import * as ThreadGroups from "../orchestration-v2/ThreadGroupsService.fork.ts";

export const forkToolHandlerServices = [
  Layer.mock(ThreadGroups.ThreadGroupsServiceFork)({}),
] as const;
