import * as Layer from "effect/Layer";
import * as Colleagues from "../collaborator/Colleagues.fork.ts";
import * as ThreadGroups from "../orchestration-v2/ThreadGroupsService.fork.ts";

export const forkToolHandlerServices = [
  Layer.mock(ThreadGroups.ThreadGroupsServiceFork)({}),
  Layer.mock(Colleagues.ColleaguesFork)({}),
] as const;
