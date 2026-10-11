// @effect-diagnostics nodeBuiltinImport:off - Exercise the launcher's native filesystem and SQLite process boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, expect, it } from "@effect/vitest";

import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";
import { backupDatabaseForMigrationsFork } from "./serviceLauncherBackup.fork.ts";
import { runServicePreflight } from "./cloud/servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import { migrationManifest } from "./persistence/Migrations.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

// Real executable and IPC boundaries, with a tiny staged runtime instead of a server.
it.each([
  { kind: "current", backup: false, outcome: "rolled-back" },
  { kind: "current", backup: false, outcome: "committed" },
  { kind: "pending", backup: true, outcome: "rolled-back" },
  { kind: "recovery", backup: true, outcome: "rolled-back" },
  { kind: "unreadable", backup: true, outcome: "rolled-back" },
  { kind: "legacy-report", backup: true, outcome: "rolled-back" },
  { kind: "invalid-report", backup: true, outcome: "rolled-back" },
  { kind: "failed-check", backup: true, outcome: "rolled-back" },
  { kind: "wrong-version", backup: true, outcome: "rolled-back" },
])("$kind preflight, $outcome trial: backup=$backup", async ({ kind, backup, outcome }) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-launcher-fork-"));
  roots.push(root);
  const databasePath = NodePath.join(root, "state.sqlite");
  if (kind === "unreadable") {
    await NodeFSP.writeFile(databasePath, "unreadable sqlite contents");
  } else {
    const database = new NodeSqlite.DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE app_records (id INTEGER PRIMARY KEY)",
      );
      const latest = Math.max(...migrationManifest.map(([id]) => id));
      database
        .prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)")
        .run(kind === "pending" ? latest - 1 : latest, "test");
    } finally {
      database.close();
    }
  }
  const original = await NodeFSP.readFile(databasePath);
  let report = runServicePreflight({
    databasePath,
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    version: "1.1.0",
  });
  if (kind === "legacy-report")
    report = { status: "ready", version: "1.1.0", launcherProtocol: SERVICE_LAUNCHER_PROTOCOL };
  if (kind === "wrong-version")
    report = {
      status: "ready",
      version: "1.2.0",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      pendingMigrationsFork: false,
    };
  const backupDir = NodePath.join(root, "runtime", "db-backup", "update-1");
  if (kind === "recovery") {
    await NodeFSP.mkdir(backupDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(backupDir, "database"), original);
    await NodeFSP.writeFile(databasePath, "writes from interrupted trial");
  }
  const observationPath = NodePath.join(root, "observed-backup.json");
  const statePath = NodePath.join(root, "runtime", "service-state.json");
  for (const version of ["1.0.0", "1.1.0"]) {
    const versionDir = NodePath.join(root, "runtime", "versions", version);
    await NodeFSP.mkdir(versionDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(versionDir, ".install-complete"), version);
    await NodeFSP.writeFile(
      NodePath.join(versionDir, "t3"),
      `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
if (process.argv[2] === "__service-preflight") {
  console.log(${JSON.stringify(kind === "invalid-report" ? "not json" : JSON.stringify(report))});
  process.exit(${kind === "failed-check" ? 1 : 0});
}
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify(existsSync(${JSON.stringify(backupDir)})));
  if (${backup}) {
    writeFileSync(context.update.dbPath, "trial writes");
    writeFileSync(context.update.dbPath + "-wal", "trial wal");
    writeFileSync(context.update.dbPath + "-shm", "trial shm");
  } else {
    const db = new DatabaseSync(context.update.dbPath);
    db.exec("ALTER TABLE app_records ADD COLUMN fork_value TEXT; INSERT INTO app_records (id) VALUES (1)");
    db.close();
  }
  if (${JSON.stringify(outcome)} === "committed") {
    process.send({ type: "prepared", updateId: context.update.id });
    process.on("message", () => process.exit(0));
  } else process.exit(1);
} else {
  if (${!backup}) {
    const db = new DatabaseSync(${JSON.stringify(databasePath)});
    // Old binary writes still work with the added nullable fork column.
    db.exec("INSERT INTO app_records (id) VALUES (2)");
    db.close();
  }
  process.exit(0);
}
`,
      { mode: 0o755 },
    );
  }
  await writeServiceState(statePath, {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    activeVersion: "1.0.0",
    update: {
      id: "update-1",
      fromVersion: "1.0.0",
      targetVersion: "1.1.0",
      dbPath: databasePath,
      status: "pending",
    },
  });
  const launcher = new Launcher(root, await readServiceState(statePath));
  // The fixture's active runtime exits after commit or rollback, completing the test without polling.
  await expect(launcher.run()).rejects.toThrow("Active child exited unexpectedly");
  expect(JSON.parse(await NodeFSP.readFile(observationPath, "utf8"))).toBe(backup);
  const state = await readServiceState(statePath);
  expect(state.update?.status).toBe(outcome);
  expect(state.activeVersion).toBe(outcome === "committed" ? "1.1.0" : "1.0.0");
  if (backup) {
    expect(await NodeFSP.readFile(databasePath)).toEqual(original);
  } else {
    const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM app_records").get()?.count).toBe(
        outcome === "committed" ? 1 : 2,
      );
      expect(
        db.prepare("SELECT fork_value FROM app_records WHERE id = 1").get()?.fork_value,
      ).toBeNull();
    } finally {
      db.close();
    }
  }
  for (const suffix of ["-wal", "-shm"]) {
    await expect(NodeFSP.stat(`${databasePath}${suffix}`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  await expect(NodeFSP.stat(backupDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("never passes the launcher's own context to the preflight runtime", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-launcher-fork-env-"));
  roots.push(root);
  // An agent running under a trial child inherits a pending context for the live database.
  const livePath = NodePath.join(root, "live.sqlite");
  await NodeFSP.writeFile(livePath, "live");
  const executable = NodePath.join(root, "t3");
  await NodeFSP.writeFile(
    executable,
    `#!${process.execPath}
const context = process.env.T3_SERVICE_LAUNCHER_CONTEXT;
if (context !== undefined) require("node:fs").writeFileSync(JSON.parse(context).update.dbPath, "clobbered");
process.exit(1);
`,
    { mode: 0o755 },
  );
  const pending = {
    id: "update-1",
    fromVersion: "1.0.0",
    targetVersion: "1.1.0",
    dbPath: livePath,
    status: "pending",
  } as const;
  const previous = process.env.T3_SERVICE_LAUNCHER_CONTEXT;
  process.env.T3_SERVICE_LAUNCHER_CONTEXT = JSON.stringify({ update: pending });
  let backedUp = false;
  try {
    await backupDatabaseForMigrationsFork(root, pending, executable, async () => {
      backedUp = true;
    });
  } finally {
    if (previous === undefined) delete process.env.T3_SERVICE_LAUNCHER_CONTEXT;
    else process.env.T3_SERVICE_LAUNCHER_CONTEXT = previous;
  }
  expect(await NodeFSP.readFile(livePath, "utf8")).toBe("live");
  expect(backedUp).toBe(true);
});
