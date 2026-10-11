// @effect-diagnostics nodeBuiltinImport:off - Exercise the launcher's native filesystem and SQLite process boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, expect, it } from "@effect/vitest";

import { migrationManifest } from "../persistence/Migrations.ts";
import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const latest = Math.max(...migrationManifest.map(([id]) => id));

it.each([
  [latest, false],
  [latest - 1, true],
  [null, true],
  [latest + 1, undefined],
  ["invalid", undefined],
] as const)("reports migration state for applied id %s", async (applied, pending) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-preflight-fork-"));
  roots.push(root);
  const databasePath = NodePath.join(root, "state.sqlite");
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE effect_sql_migrations (migration_id, name TEXT)");
    if (applied !== null) {
      database.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)").run(applied, "test");
    }
  } finally {
    database.close();
  }
  const before = await NodeFSP.readFile(databasePath);
  const result = runServicePreflight({ databasePath, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL });
  expect(result.status).toBe("ready");
  expect(result.status === "ready" ? result.pendingMigrationsFork : undefined).toBe(pending);
  expect(await NodeFSP.readFile(databasePath)).toEqual(before);
  expect(await NodeFSP.readdir(root)).toEqual(["state.sqlite"]);
});

it.each(["missing", "corrupt", "missing-table"])("fails safe for a %s database", async (kind) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-preflight-fork-"));
  roots.push(root);
  const databasePath = NodePath.join(root, "state.sqlite");
  if (kind === "corrupt") await NodeFSP.writeFile(databasePath, "not a sqlite database");
  if (kind === "missing-table") new NodeSqlite.DatabaseSync(databasePath).close();
  expect(
    runServicePreflight({ databasePath, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL }),
  ).toEqual({
    status: "ready",
    version: expect.any(String),
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
  });
  if (kind === "missing")
    await expect(NodeFSP.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
});
