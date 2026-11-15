import * as Layer from "effect/Layer";
import * as IssueService from "../issues/IssueService.ts";
import * as ThreadGroups from "../orchestration-v2/ThreadGroupsService.fork.ts";

export const forkToolHandlerServices = [
  Layer.mock(IssueService.IssueService)({}),
  Layer.mock(ThreadGroups.ThreadGroupsServiceFork)({}),
] as const;
