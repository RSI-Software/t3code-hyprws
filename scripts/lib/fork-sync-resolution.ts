// @effect-diagnostics nodeBuiltinImport:off - The marker is Git plumbing over the common git dir.

import { SYNC_RESOLUTION_BRANCH } from "./fork-policy.ts";
import { git, gitResult, lines, runRequire, type CommandRunner } from "./fork-sync-git.ts";
import { FOLD_AMEND_LINE } from "./fork-sync-todo.ts";

/**
 * A session hands its rebased tip to the land run as one empty-message marker commit on
 * `sync/resolution` whose parent is the tip. Trailers name the target tag and lease; a partial
 * marker's body is the remaining rebase todo. The marker's tree is the lease's: a push runs the
 * pushed commit's workflow files, and those must be the trunk's, never a resolver's.
 */
export const RESOLUTION_REF = "refs/fork-sync/resolution";
const RESOLUTION_REMOTE_REF = `refs/remotes/origin/${SYNC_RESOLUTION_BRANCH}`;
const TAG_TRAILER = "Fork-Sync-Tag";
const LEASE_TRAILER = "Fork-Sync-Lease";
const SHA = /^[0-9a-f]{40}$/;
const PICK_LINE = /^(?:pick|fixup|squash|fixup -[cC]) ([0-9a-f]{40})(?: .*)?$/;

export interface Marker {
  readonly commit: string;
  /** The rebased tip: the marker's parent. */
  readonly tip: string;
  readonly tag: string;
  /** The trunk sha whose fork stack the tip replays. */
  readonly lease: string;
  /** The rest of the rebase todo; `null` once the rebase finished. */
  readonly todo: ReadonlyArray<string> | null;
}

/** The commits a todo replays, so a resume can refuse one outside its stack. */
export const todoCommits = (todo: ReadonlyArray<string>): ReadonlyArray<string> =>
  todo.flatMap((line) => PICK_LINE.exec(line)?.[1] ?? []);

const todoLine = (line: string): boolean => PICK_LINE.test(line) || FOLD_AMEND_LINE.test(line);

const markerMessage = (marker: Omit<Marker, "commit">): string =>
  [
    marker.todo === null
      ? `fork-sync finished ${marker.tag}`
      : `fork-sync partial ${marker.tag}: ${todoCommits(marker.todo).length} commits left`,
    "",
    ...(marker.todo === null ? [] : [...marker.todo, ""]),
    `${TAG_TRAILER}: ${marker.tag}`,
    `${LEASE_TRAILER}: ${marker.lease}`,
    "",
  ].join("\n");

/** The marker `ref` names, or `null` when it holds anything else. */
export const readMarker = (runner: CommandRunner, root: string, ref: string): Marker | null => {
  const shown = gitResult(runner, root, ["show", "-s", "--format=%H %P%n%B", ref]);
  if (shown.status !== 0 || shown.error !== undefined) return null;
  const [head = "", subject = "", blank, ...rest] = shown.stdout.replace(/\n+$/, "").split("\n");
  const [commit = "", tip = "", ...extra] = head.split(" ");
  const lease = rest.at(-1)?.match(new RegExp(`^${LEASE_TRAILER}: ([0-9a-f]{40})$`))?.[1];
  const tag = rest.at(-2)?.match(new RegExp(`^${TAG_TRAILER}: (v\\S+)$`))?.[1];
  if (
    !SHA.test(tip) ||
    extra.length > 0 ||
    blank !== "" ||
    lease === undefined ||
    tag === undefined
  )
    return null;
  const body = rest.slice(0, -2).filter((line) => line !== "");
  if (!subject.startsWith(`fork-sync ${body.length === 0 ? "finished" : "partial"} ${tag}`))
    return null;
  if (!body.every(todoLine)) return null;
  return { commit, tip, tag, lease, todo: body.length === 0 ? null : body };
};

/**
 * Write the marker for `tip` at `RESOLUTION_REF`. An unchanged marker, local
 * or on origin, is reused, so a rerun that changed nothing pushes nothing new.
 */
export const writeMarker = (
  runner: CommandRunner,
  root: string,
  marker: Omit<Marker, "commit">,
): Marker => {
  const same = [RESOLUTION_REF, RESOLUTION_REMOTE_REF]
    .map((ref) => readMarker(runner, root, ref))
    .find(
      (existing) =>
        existing !== null &&
        existing.tip === marker.tip &&
        existing.tag === marker.tag &&
        existing.lease === marker.lease &&
        JSON.stringify(existing.todo) === JSON.stringify(marker.todo),
    );
  const commit =
    same?.commit ??
    runRequire(
      runner,
      "git",
      ["commit-tree", `${marker.lease}^{tree}`, "-p", marker.tip, "-F", "-"],
      {
        cwd: root,
        input: markerMessage(marker),
      },
    ).trim();
  git(runner, root, ["update-ref", RESOLUTION_REF, commit]);
  return { ...marker, commit };
};

/**
 * Fetch `origin/sync/resolution`. No branch, or a branch holding anything but
 * a marker (the retired resolution-data commits among them), reads as none.
 */
export const fetchMarker = (runner: CommandRunner, root: string): Marker | null => {
  const remoteRef = `refs/heads/${SYNC_RESOLUTION_BRANCH}`;
  const listed = gitResult(runner, root, ["ls-remote", "--exit-code", "origin", remoteRef]);
  if (listed.status === 2) return null;
  if (listed.status !== 0 || listed.error !== undefined)
    throw new Error(
      `git ls-remote origin ${remoteRef} failed: ${listed.stderr.trim() || listed.error?.message || "no output"}`,
    );
  git(runner, root, ["fetch", "--no-tags", "origin", `+${remoteRef}:${RESOLUTION_REMOTE_REF}`]);
  const marker = readMarker(runner, root, RESOLUTION_REMOTE_REF);
  if (marker === null)
    process.stdout.write(`sync: origin/${SYNC_RESOLUTION_BRANCH} holds no marker; ignoring it\n`);
  return marker;
};

/**
 * The rest of a stopped rebase as a portable todo: the stopped line first,
 * every commit by its full sha, comments dropped. A line outside the marker
 * grammar refuses the handoff rather than lose work.
 */
export const remainingTodo = (
  runner: CommandRunner,
  worktree: string,
  done: string,
  todo: string,
): ReadonlyArray<string> => {
  const commandLines = (text: string) =>
    lines(text).filter((line) => /^[a-z]/.test(line) && line !== "noop");
  const remaining = [...commandLines(done).slice(-1), ...commandLines(todo)];
  const abbreviated = remaining.flatMap(
    (line) => /^(?:pick|fixup|squash|fixup -[cC]) ([0-9a-f]{4,40})/.exec(line)?.[1] ?? [],
  );
  const full =
    abbreviated.length === 0
      ? []
      : lines(git(runner, worktree, ["rev-parse", ...abbreviated.map((sha) => `${sha}^{commit}`)]));
  let next = 0;
  const expanded = remaining.map((line) =>
    line.replace(
      /^(pick|fixup|squash|fixup -[cC]) [0-9a-f]{4,40}/,
      (_, command: string) => `${command} ${full[next++]}`,
    ),
  );
  const foreign = expanded.find((line) => !todoLine(line));
  if (foreign !== undefined)
    throw new Error(`the rebase todo holds '${foreign}', which a partial marker cannot carry`);
  return expanded;
};
