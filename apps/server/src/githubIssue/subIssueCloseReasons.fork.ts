// Fork-only: the issue detail read omits a child's close reason, so a detail with a closed
// child attaches the children's reasons with one extra GraphQL call, fired only when a closed
// child exists whose reason an open child never has (RSI-Software/t3code-hyprws#1461).
import type { GitHubSubIssue } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import { decodeGitHubSubIssueReasons } from "./gitHubIssueJson.ts";

// GitHub caps the `subIssues` connection at `first: 100`; asking for more fails the whole query.
export const SUB_ISSUE_REASONS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){subIssues(first:100){nodes{number stateReason}}}}}";

/** Children with their real close reasons, or unchanged children when the read has nothing to
 * add: an unknown reason must degrade the glyph, never the whole detail. */
export const attachSubIssueCloseReasons = Effect.fn("attachSubIssueCloseReasons")(function* (
  api: GitHubApi.GitHubApi["Service"],
  input: {
    readonly host: string;
    readonly repository: string;
    readonly parentNumber: number;
    readonly children: ReadonlyArray<GitHubSubIssue>;
  },
) {
  if (!input.children.some((child) => child.state === "closed")) return [...input.children];
  const [owner, name] = input.repository.split("/");
  if (owner === undefined || owner.length === 0 || name === undefined || name.length === 0) {
    return [...input.children];
  }
  const body = yield* api
    .graphql({
      host: input.host,
      operation: "subIssueCloseReasons",
      query: SUB_ISSUE_REASONS_QUERY,
      variables: { owner, name, number: input.parentNumber },
    })
    .pipe(
      Effect.tapError((error) =>
        Effect.logWarning("sub-issue close reason read failed", { detail: error.message }),
      ),
      Effect.option,
    );
  if (Option.isNone(body)) return [...input.children];
  const reasons = yield* decodeGitHubSubIssueReasons(body.value).pipe(Effect.option);
  if (Option.isNone(reasons)) return [...input.children];
  return input.children.map((child) =>
    reasons.value.has(child.number)
      ? { ...child, closeReason: reasons.value.get(child.number) ?? null }
      : child,
  );
});
