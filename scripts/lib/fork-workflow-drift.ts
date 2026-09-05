// Fork workflow copies are intentionally different. Bind a reviewed decision to
// both blobs instead of assuming an automerge carried upstream's prerequisites.
export const WORKFLOW_REVIEWS_PATH = ".github/fork-workflow-reviews.json";
export const CURRENT_WORKFLOW_REVIEW_VERSION = 2;

export const WORKFLOW_COPIES = [
  { upstream: ".github/workflows/ci.yml", fork: ".github/workflows/hyprws-ci.yml" },
  { upstream: ".github/workflows/release.yml", fork: ".github/workflows/hyprws-release.yml" },
] as const;

const RELEASE_OUTCOME_FILE = "FORK_RELEASE_OUTCOME_FILE";
const RELEASE_OUTCOME_FILENAME = "fork-release-outcome-receipts.json";
const RELEASE_OUTCOME_PATH = `\${{ runner.temp }}/\${{ env.${RELEASE_OUTCOME_FILE} }}`;
export const RELEASE_OUTCOME_GUARD = "release-outcome-evidence-v1";

const workflowJob = (workflow: string, name: string): string | undefined => {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) return undefined;
  const following = workflow.slice(start + marker.length);
  const end = following.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return end === -1 ? following : following.slice(0, end);
};

const workflowStep = (workflow: string, name: string): string | undefined => {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) return undefined;
  const following = workflow.slice(start + marker.length);
  const end = following.search(/^      - name: /m);
  return end === -1 ? following : following.slice(0, end);
};

const workflowMapping = (workflow: string, name: string, indent: number): string | undefined => {
  const lines = workflow.split("\n");
  const marker = `${" ".repeat(indent)}${name}:`;
  const start = lines.findIndex((line) => line === marker || line.startsWith(`${marker} `));
  if (start === -1) return undefined;
  const following = lines.slice(start + 1);
  const end = following.findIndex(
    (line) => line.trim().length > 0 && line.length - line.trimStart().length <= indent,
  );
  return (end === -1 ? following : following.slice(0, end)).join("\n");
};

export const releaseOutcomeExportProblem = (workflow: string): string | undefined => {
  const outcome = workflowJob(workflow, "outcome");
  if (outcome === undefined) return "outcome job must declare if: always()";

  const outcomeConditions = outcome.match(/^    if\s*:.*$/gm);
  if (
    outcomeConditions?.length !== 1 ||
    outcomeConditions[0] !== "    if: always()" ||
    /^    continue-on-error\s*:/m.test(outcome)
  )
    return "outcome job must declare exact if: always() without continue-on-error";

  const fileDeclarations = outcome.match(
    new RegExp(`^      ${RELEASE_OUTCOME_FILE}\\s*:.*$`, "gm"),
  );
  if (
    fileDeclarations?.length !== 1 ||
    fileDeclarations[0] !== `      ${RELEASE_OUTCOME_FILE}: ${RELEASE_OUTCOME_FILENAME}`
  )
    return `${RELEASE_OUTCOME_FILE} must equal ${RELEASE_OUTCOME_FILENAME} in the outcome job env`;

  const exportDeclarations = workflow.match(/^\s+FORK_OUTCOME_EXPORT: .*$/gm);
  if (exportDeclarations?.length !== 1)
    return "FORK_OUTCOME_EXPORT must be declared once in the release workflow";

  const retain = workflowStep(outcome, "Retain release outcome");
  const retainEnv = retain === undefined ? undefined : workflowMapping(retain, "env", 8);
  if (
    retainEnv === undefined ||
    !retainEnv.split("\n").includes(`          FORK_OUTCOME_EXPORT: ${RELEASE_OUTCOME_PATH}`)
  )
    return "FORK_OUTCOME_EXPORT must use the shared path in Retain release outcome env";

  const verify = workflowStep(outcome, "Verify retained release outcome");
  const verifyLines = verify?.split("\n");
  const retainIndex = outcome.indexOf("      - name: Retain release outcome\n");
  const verifyIndex = outcome.indexOf("      - name: Verify retained release outcome\n");
  const uploadIndex = outcome.indexOf("      - name: Upload distribution evidence\n");
  if (
    verify === undefined ||
    !verifyLines?.includes('        run: test -s "$RUNNER_TEMP/$FORK_RELEASE_OUTCOME_FILE"') ||
    verifyLines.some((line) => /^        (?:if|continue-on-error)\s*:/.test(line)) ||
    retainIndex >= verifyIndex ||
    verifyIndex >= uploadIndex
  )
    return "Verify retained release outcome must unconditionally test the retained receipt is nonempty between collection and upload";

  const upload = workflowStep(outcome, "Upload distribution evidence");
  const uploadWith = upload === undefined ? undefined : workflowMapping(upload, "with", 8);
  const uploadPath = uploadWith === undefined ? undefined : workflowMapping(uploadWith, "path", 10);
  if (
    uploadPath === undefined ||
    !uploadPath.split("\n").some((line) => line.trim() === RELEASE_OUTCOME_PATH)
  )
    return "Upload distribution evidence with.path must use the FORK_OUTCOME_EXPORT path";
  if (!uploadWith?.split("\n").includes("          if-no-files-found: error"))
    return "Upload distribution evidence must error when outcome files are missing";

  return undefined;
};

const WORKFLOW_GUARDS = new Map<
  string,
  { readonly fork: string; readonly problem: (workflow: string) => string | undefined }
>([
  [
    RELEASE_OUTCOME_GUARD,
    {
      fork: ".github/workflows/hyprws-release.yml",
      problem: releaseOutcomeExportProblem,
    },
  ],
]);

interface WorkflowReview {
  readonly upstream: string;
  readonly fork: string;
  readonly upstreamCommit: string;
  readonly upstreamBlob: string;
  readonly forkBlob: string;
  readonly disposition: "adapted" | "no-change";
  readonly reason: string;
  readonly guards?: ReadonlyArray<string>;
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
  if (
    (document.version !== 1 && document.version !== CURRENT_WORKFLOW_REVIEW_VERSION) ||
    !Array.isArray(document.reviews)
  )
    throw new Error(
      `invalid ${WORKFLOW_REVIEWS_PATH}: expected version 1 or ${CURRENT_WORKFLOW_REVIEW_VERSION} and reviews`,
    );
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
    if (row.guards !== undefined) {
      if (!Array.isArray(row.guards) || row.guards.some((guard) => typeof guard !== "string"))
        throw new Error("invalid workflow review: guards must be an array of strings");
      if (row.guards.length !== new Set(row.guards).size)
        throw new Error("invalid workflow review: guards must not contain duplicate IDs");
      const unknown = row.guards.find((guard) => !WORKFLOW_GUARDS.has(guard as string));
      if (unknown !== undefined)
        throw new Error(`invalid workflow review: unknown guard ${unknown}`);
    }
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
    for (const guard of review.guards ?? []) {
      const registration = WORKFLOW_GUARDS.get(guard);
      if (registration?.fork !== review.fork)
        throw new Error(`${guard} is not valid for workflow ${review.fork}`);
    }
    if (seen.has(review.upstream)) throw new Error(`duplicate workflow review: ${review.upstream}`);
    seen.add(review.upstream);
  }
  if (
    document.version === CURRENT_WORKFLOW_REVIEW_VERSION &&
    !reviews
      .find(({ fork }) => fork === ".github/workflows/hyprws-release.yml")
      ?.guards?.includes(RELEASE_OUTCOME_GUARD)
  )
    throw new Error(
      `workflow review version ${CURRENT_WORKFLOW_REVIEW_VERSION} requires guard ${RELEASE_OUTCOME_GUARD}`,
    );
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
    else
      for (const guard of review.guards ?? []) {
        const guardProblem = WORKFLOW_GUARDS.get(guard)?.problem;
        if (guardProblem === undefined) continue;
        problem = guardProblem(git.run(["show", `${head}:${fork}`]));
        if (problem !== undefined) break;
      }
    return { upstream, fork, upstreamBlob, forkBlob, review, problem };
  });
};
