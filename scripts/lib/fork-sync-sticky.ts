import {
  FORK_REPOSITORY,
  HYPRWS_BRANCH,
  SYNC_CANDIDATE_BRANCH,
  SYNC_RESOLUTION_BRANCH,
} from "./fork-policy.ts";
import { runRequire, type CommandRunner } from "./fork-sync-git.ts";

/**
 * The land run's one live-status comment on the open attention issue, edited in place.
 * `hyprws-sync-resolution.yml` reruns the sync only on rsi-pr-agent's comments, so this
 * one never triggers a run; keep its gate on that author.
 */
export const DRIVER_STICKY_MARKER = "<!-- hyprws:sync-driver -->";

export type DriverState =
  | { readonly kind: "rebasing" }
  | { readonly kind: "ci" | "landing"; readonly candidate: string }
  | { readonly kind: "landed"; readonly sha: string }
  | {
      readonly kind: "blocked" | "failed";
      readonly step: string;
      readonly detail: string;
      /** The candidate's hyprws CI run, when one ran. */
      readonly ci: string | null;
    };

export interface DriverRun {
  readonly tag: string;
  readonly startedAt: Date;
  /** The `sync/resolution` commit this run adopted, if any. */
  readonly picked: string | null;
  readonly url: string | null;
}

const DETAIL_LIMIT = 400;
const short = (sha: string): string => `\`${sha.slice(0, 7)}\``;

const stateLine = (state: DriverState): string => {
  switch (state.kind) {
    case "rebasing":
      return "**rebasing**";
    case "ci":
      return `**ci** on \`${SYNC_CANDIDATE_BRANCH}\` ${short(state.candidate)}`;
    case "landing":
      return `**landing** ${short(state.candidate)} on \`${HYPRWS_BRANCH}\``;
    case "landed":
      return `✅ **landed**: \`${HYPRWS_BRANCH}\` is ${short(state.sha)}`;
    case "blocked":
    case "failed": {
      const detail =
        state.detail.length > DETAIL_LIMIT
          ? `${state.detail.slice(0, DETAIL_LIMIT)}…`
          : state.detail;
      const ci = state.ci === null ? "" : ` · [ci run](${state.ci})`;
      return `${state.kind === "blocked" ? "🛑" : "❌"} **${state.kind}** at \`${state.step}\`: ${detail}${ci}`;
    }
  }
};

export const renderDriverSticky = (run: DriverRun, state: DriverState, now: Date): string => {
  const minutes = Math.max(0, Math.round((now.getTime() - run.startedAt.getTime()) / 60_000));
  const started = `${run.startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return [
    DRIVER_STICKY_MARKER,
    `### 🔄 Upstream sync · \`${run.tag}\``,
    "",
    stateLine(state),
    ...(run.picked === null
      ? []
      : ["", `picked up \`${SYNC_RESOLUTION_BRANCH}\` ${short(run.picked)}`]),
    "",
    `<sub>🕐 ${started} · ⏱️ ${minutes} min${run.url === null ? "" : ` · [run](${run.url})`}</sub>`,
  ].join("\n");
};

/**
 * Posts each state to the open attention issue's driver comment. It looks the issue up once;
 * an end state names the issue it published. Best effort: a refused write never fails the run.
 */
export const driverSticky = (
  runner: CommandRunner,
  root: string,
  run: DriverRun,
  openIssue: () => number | null,
  now: () => Date,
) => {
  const api = (args: ReadonlyArray<string>): string =>
    runRequire(runner, "gh", ["api", ...args], { cwd: root });
  let standing: number | null | undefined;
  let comment: { readonly issue: number; id: string | null } | null = null;
  return (state: DriverState, published?: number | null): void => {
    try {
      const issue = published ?? (standing === undefined ? (standing = openIssue()) : standing);
      if (issue === null) return;
      const body = renderDriverSticky(run, state, now());
      if (comment?.issue !== issue) {
        const found = api([
          "--paginate",
          `repos/${FORK_REPOSITORY}/issues/${issue}/comments`,
          "--jq",
          `.[] | select(.body | startswith("${DRIVER_STICKY_MARKER}")) | .id`,
        ]);
        comment = { issue, id: /^\d+$/m.exec(found)?.[0] ?? null };
      }
      if (comment.id === null)
        comment.id = api([
          `repos/${FORK_REPOSITORY}/issues/${issue}/comments`,
          "-f",
          `body=${body}`,
          "--jq",
          ".id",
        ]).trim();
      else
        api([
          "-X",
          "PATCH",
          `repos/${FORK_REPOSITORY}/issues/comments/${comment.id}`,
          "-f",
          `body=${body}`,
        ]);
    } catch (error) {
      process.stderr.write(
        `sync: driver status not posted: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
};
