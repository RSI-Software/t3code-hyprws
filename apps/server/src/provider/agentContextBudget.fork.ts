import * as Layer from "effect/Layer";
import * as GitHubIssueService from "../githubIssue/GitHubIssueService.ts";
import * as ThreadGroups from "../orchestration-v2/ThreadGroupsService.fork.ts";

export const forkToolHandlerServices = [
  Layer.mock(GitHubIssueService.GitHubIssueService)({}),
  Layer.mock(ThreadGroups.ThreadGroupsServiceFork)({}),
] as const;
