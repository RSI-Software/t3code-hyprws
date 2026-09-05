// Fork workflow copies are intentionally different. Bind a reviewed decision to
// both blobs instead of assuming an automerge carried upstream's prerequisites.
export const WORKFLOW_REVIEWS_PATH = ".github/fork-workflow-reviews.json";

export const WORKFLOW_COPIES = [
  { upstream: ".github/workflows/ci.yml", fork: ".github/workflows/hyprws-ci.yml" },
  { upstream: ".github/workflows/release.yml", fork: ".github/workflows/hyprws-release.yml" },
] as const;

interface WorkflowReview {
  readonly upstream: string;
  readonly fork: string;
  readonly upstreamCommit: string;
  readonly upstreamBlob: string;
  readonly forkBlob: string;
  readonly disposition: "adapted" | "no-change";
  readonly reason: string;
}

export interface WorkflowDrift {
  readonly upstream: string;
  readonly fork: string;
  readonly upstreamBlob: string;
  readonly forkBlob: string;
  readonly review: WorkflowReview | undefined;
  readonly problem: string | undefined;
}

interface GitReader {
  readonly run: (args: ReadonlyArray<string>) => string;
}

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`invalid ${WORKFLOW_REVIEWS_PATH}: expected an object`);
  return value as Record<string, unknown>;
};

export const parseWorkflowReviews = (raw: string): ReadonlyArray<WorkflowReview> => {
  const document = object(JSON.parse(raw));
  if (document.version !== 1 || !Array.isArray(document.reviews))
    throw new Error(`invalid ${WORKFLOW_REVIEWS_PATH}: expected version 1 and reviews`);
  const reviews = document.reviews.map((value: unknown): WorkflowReview => {
    const row = object(value);
    for (const key of ["upstream", "fork", "upstreamCommit", "upstreamBlob", "forkBlob", "reason"])
      if (typeof row[key] !== "string" || row[key].trim().length === 0)
        throw new Error(`invalid workflow review: ${key} must be nonempty`);
    for (const key of ["upstreamCommit", "upstreamBlob", "forkBlob"])
      if (!/^[a-f0-9]{40}$/.test(String(row[key])))
        throw new Error(`invalid workflow review: ${key} must be a full Git object ID`);
    if (row.disposition !== "adapted" && row.disposition !== "no-change")
      throw new Error("invalid workflow review: disposition must be adapted or no-change");
    return row as unknown as WorkflowReview;
  });
  const seen = new Set<string>();
  for (const review of reviews) {
    if (
      !WORKFLOW_COPIES.some(
        ({ upstream, fork }) => upstream === review.upstream && fork === review.fork,
      )
    )
      throw new Error(`invalid workflow review counterpart: ${review.upstream} -> ${review.fork}`);
    if (seen.has(review.upstream)) throw new Error(`duplicate workflow review: ${review.upstream}`);
    seen.add(review.upstream);
  }
  return reviews;
};

export const readWorkflowDrift = (
  git: GitReader,
  head: string,
  target: string,
): ReadonlyArray<WorkflowDrift> => {
  // Read the selected head, not a dirty approval in the caller's working tree.
  const reviews = parseWorkflowReviews(git.run(["show", `${head}:${WORKFLOW_REVIEWS_PATH}`]));
  const blob = (ref: string, path: string) => git.run(["rev-parse", `${ref}:${path}`]).trim();
  return WORKFLOW_COPIES.map(({ upstream, fork }) => {
    const upstreamBlob = blob(target, upstream);
    const forkBlob = blob(head, fork);
    const review = reviews.find((row) => row.upstream === upstream);
    let problem: string | undefined;
    if (review === undefined) problem = "missing adaptation or reasoned no-change review";
    else if (blob(review.upstreamCommit, upstream) !== review.upstreamBlob)
      problem = "review provenance does not match its upstream blob";
    else if (review.upstreamBlob !== upstreamBlob)
      problem = "upstream workflow changed since review";
    else if (review.forkBlob !== forkBlob) problem = "fork counterpart changed since review";
    return { upstream, fork, upstreamBlob, forkBlob, review, problem };
  });
};
