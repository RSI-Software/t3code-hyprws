// Fork-owned team-project mark (colleague-collab). A `project.update` carries `teamFork`
// through the upstream command and `project.meta-updated` event; the projection keeps it in
// `fork_team_projects`, and project reads attach it, so upstream's project table stays as is.
import type { ApplicationProjectEvent, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

/** Spread into a project or its shell: only a team project carries the key. */
export const teamProjectFieldFork = (row: { readonly teamFork?: boolean | undefined }) =>
  row.teamFork === true ? { teamFork: true } : {};

/**
 * Projects the mark; runs inside the event's commit transaction, so it replays with it.
 * Untraced: it runs per event inside `ProjectStoreV2.apply`'s span.
 */
export const applyTeamProjectFork = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  event: ApplicationProjectEvent,
) {
  const projectId = event.payload.projectId;
  const mark = event.type === "project.meta-updated" ? event.payload.teamFork : undefined;
  if (event.type === "project.deleted" || mark === false) {
    yield* sql`DELETE FROM fork_team_projects WHERE project_id = ${projectId}`;
  } else if (mark === true) {
    yield* sql`
      INSERT INTO fork_team_projects (project_id, marked_at)
      VALUES (${projectId}, ${event.occurredAt})
      ON CONFLICT (project_id) DO NOTHING
    `;
  }
});

/**
 * Upstream's project reads with the mark attached. Spread last into the store, so it replaces
 * `get`, `list`, `findActiveByWorkspaceRoot` and the shell reads built on them; `apply` keeps
 * upstream's unmarked `get`.
 */
export const teamProjectReadsFork = Effect.fn("TeamProjectsFork.reads")(function* <
  Row extends { readonly projectId: ProjectId },
  Shell,
  E,
  ListOptions extends { readonly projectIds?: ReadonlyArray<ProjectId> },
>(input: {
  readonly get: (
    projectId: ProjectId,
    options?: { readonly includeDeleted?: boolean },
  ) => Effect.Effect<Option.Option<Row>, E>;
  readonly list: (options?: ListOptions) => Effect.Effect<ReadonlyArray<Row>, E>;
  readonly findActiveByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<Row>, E>;
  readonly toShell: (row: Row) => Shell;
  readonly mapError: (
    operation: string,
  ) => <A, E2, R>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E, R>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { toShell } = input;
  const mark = Effect.fn("TeamProjectsFork.mark")(function* (rows: ReadonlyArray<Row>) {
    if (rows.length === 0) return rows;
    const marked = yield* sql<{ readonly projectId: string }>`
      SELECT project_id AS "projectId" FROM fork_team_projects
      WHERE ${sql.in(
        "project_id",
        rows.map((row) => row.projectId),
      )}
    `.pipe(NodeSqliteClient.readOnly, input.mapError("teamProjects"));
    const team = new Set(marked.map((row) => row.projectId));
    return rows.map((row) => (team.has(row.projectId) ? { ...row, teamFork: true } : row));
  });
  const markOne = (row: Option.Option<Row>) =>
    mark(Option.toArray(row)).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])));
  const get = Effect.fn("ProjectStoreV2.get")(function (
    projectId: ProjectId,
    options?: { readonly includeDeleted?: boolean },
  ) {
    return input.get(projectId, options).pipe(Effect.flatMap(markOne));
  });
  const list = Effect.fn("ProjectStoreV2.list")(function (options?: ListOptions) {
    return input.list(options).pipe(Effect.flatMap(mark));
  });
  const reads = {
    get,
    list,
    findActiveByWorkspaceRoot: Effect.fn("ProjectStoreV2.findActiveByWorkspaceRoot")(function (
      workspaceRoot: string,
    ) {
      return input.findActiveByWorkspaceRoot(workspaceRoot).pipe(Effect.flatMap(markOne));
    }),
    getShell: Effect.fn("ProjectStoreV2.getShell")(function (projectId: ProjectId) {
      return get(projectId).pipe(Effect.map(Option.map(toShell)));
    }),
    listShells: Effect.fn("ProjectStoreV2.listShells")(function (options?: ListOptions) {
      return list(options).pipe(Effect.map((rows) => rows.map(toShell)));
    }),
  };
  // Partial only so the spread may follow upstream's own keys (TS2783); every key is set.
  return reads as Partial<typeof reads>;
});
