/**
 * The remote_resources and catalog_sync_roles CHECK rebuild for `pipelines`.
 *
 * A database created before `pipelines` existed has the old CHECK on both
 * tables. Opening it must (1) rebuild both tables without losing a row, (2) then
 * accept domain `pipelines`, and (3) do nothing on the next open. The next open
 * is a separate process, so it is a real restart, the way the live server gets
 * its migrations. Every database here lives under the OS temp directory; none
 * of them is one of the repo's databases.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const DB_MODULE = fileURLToPath(new URL("../db.mjs", import.meta.url));

function freshDbPath(label) {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `target-${label}-`)), "legacy.db");
}

/** The pre-`pipelines` shape: same columns, the old CHECK lists, and the rows an operator would have. */
function createLegacyDb(dbPath) {
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE remote_resources (
			client_id     TEXT NOT NULL,
			domain        TEXT NOT NULL CHECK (domain IN ('templates', 'tcp_tools', 'resource_sets')),
			resource_id   TEXT NOT NULL,
			name          TEXT NOT NULL,
			resource_json TEXT NOT NULL,
			revision      INTEGER NOT NULL DEFAULT 1,
			updated_at    TEXT NOT NULL,
			PRIMARY KEY (client_id, domain, resource_id)
		);
		CREATE INDEX idx_remote_resources_client_domain ON remote_resources(client_id, domain);
		CREATE TABLE catalog_sync_roles (
			domain      TEXT NOT NULL CHECK (domain IN ('templates', 'tcps', 'resource_sets')),
			resource_id TEXT NOT NULL,
			role_id     TEXT NOT NULL,
			PRIMARY KEY (domain, resource_id, role_id)
		);
		CREATE INDEX idx_catalog_sync_roles_role ON catalog_sync_roles(role_id);
	`);
	const insertResource = db.prepare(
		"INSERT INTO remote_resources (client_id, domain, resource_id, name, resource_json, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	insertResource.run("client-a", "templates", "tpl-1", "Build", '{"steps":[]}', 3, "2026-01-01T00:00:00.000Z");
	insertResource.run("client-a", "tcp_tools", "tcp-1", "Packs", '{"tools":[]}', 1, "2026-01-02T00:00:00.000Z");
	insertResource.run("client-b", "resource_sets", "rs-1", "Set", '{"resources":[]}', 2, "2026-01-03T00:00:00.000Z");
	db.prepare("INSERT INTO catalog_sync_roles (domain, resource_id, role_id) VALUES (?, ?, ?)").run("tcps", "tcp-1", "admin");
	db.close();
}

function snapshot(dbPath) {
	const db = new DatabaseSync(dbPath);
	try {
		const resources = db
			.prepare("SELECT client_id, domain, resource_id, name, resource_json, revision, updated_at FROM remote_resources ORDER BY client_id, domain, resource_id")
			.all();
		const roles = db.prepare("SELECT domain, resource_id, role_id FROM catalog_sync_roles ORDER BY domain, resource_id, role_id").all();
		const tables = Object.fromEntries(
			db
				.prepare("SELECT name, sql, rootpage FROM sqlite_master WHERE type = 'table' AND name IN ('remote_resources', 'catalog_sync_roles')")
				.all()
				.map((row) => [row.name, row]),
		);
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_remote_resources_client_domain', 'idx_catalog_sync_roles_role') ORDER BY name")
			.all()
			.map((row) => row.name);
		return { resources, roles, tables, indexes };
	} finally {
		db.close();
	}
}

/** Opens the database through db.mjs in a fresh process, which runs every migration. */
function openInChildProcess(dbPath) {
	const script = `
		const db = await import(${JSON.stringify(DB_MODULE)});
		db.open(${JSON.stringify(dbPath)});
		process.stdout.write("opened");
	`;
	return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, TARGET_SERVER_DB: dbPath },
		encoding: "utf8",
	});
}

test("opening an old-schema database rebuilds both CHECKs without losing rows, then accepts pipelines", () => {
	const dbPath = freshDbPath("pipelines-migrate");
	createLegacyDb(dbPath);
	const before = snapshot(dbPath);
	assert.equal(before.resources.length, 3);
	assert.equal(before.roles.length, 1);
	assert.ok(!before.tables.remote_resources.sql.includes("'pipelines'"));

	assert.equal(openInChildProcess(dbPath), "opened");

	const after = snapshot(dbPath);
	assert.deepEqual(after.resources, before.resources, "remote_resources rows must be preserved exactly");
	assert.deepEqual(after.roles, before.roles, "catalog_sync_roles rows must be preserved exactly");
	assert.ok(after.tables.remote_resources.sql.includes("'pipelines'"));
	assert.ok(after.tables.catalog_sync_roles.sql.includes("'pipelines'"));
	assert.deepEqual(after.indexes, ["idx_catalog_sync_roles_role", "idx_remote_resources_client_domain"]);

	const db = new DatabaseSync(dbPath);
	db.prepare(
		"INSERT INTO remote_resources (client_id, domain, resource_id, name, resource_json, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run("client-a", "pipelines", "pl-1", "verify", "{}", 1, "2026-02-01T00:00:00.000Z");
	db.prepare("INSERT INTO catalog_sync_roles (domain, resource_id, role_id) VALUES (?, ?, ?)").run("pipelines", "pl-1", "admin");
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM remote_resources WHERE domain = 'pipelines'").get().n, 1);
	assert.throws(
		() =>
			db
				.prepare("INSERT INTO remote_resources (client_id, domain, resource_id, name, resource_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
				.run("client-a", "unknown", "x", "x", "{}", "2026-02-01T00:00:00.000Z"),
		/CHECK constraint/,
	);
	db.close();
});

test("a second open is a no-op: the tables are not rebuilt again and no row changes", () => {
	const dbPath = freshDbPath("pipelines-idempotent");
	createLegacyDb(dbPath);
	openInChildProcess(dbPath);
	const first = snapshot(dbPath);

	assert.equal(openInChildProcess(dbPath), "opened");
	assert.equal(openInChildProcess(dbPath), "opened");

	const second = snapshot(dbPath);
	assert.deepEqual(second.resources, first.resources);
	assert.deepEqual(second.roles, first.roles);
	// A rebuild creates a new table with a new root page, so an unchanged root page
	// proves the second and third opens did not rebuild anything.
	assert.equal(second.tables.remote_resources.rootpage, first.tables.remote_resources.rootpage);
	assert.equal(second.tables.catalog_sync_roles.rootpage, first.tables.catalog_sync_roles.rootpage);
	assert.deepEqual(second.indexes, first.indexes);
});

test("a fresh database is created with pipelines already allowed and needs no rebuild", () => {
	const dbPath = freshDbPath("pipelines-fresh");
	openInChildProcess(dbPath);
	const first = snapshot(dbPath);
	assert.ok(first.tables.remote_resources.sql.includes("'pipelines'"));
	assert.ok(first.tables.catalog_sync_roles.sql.includes("'pipelines'"));
	openInChildProcess(dbPath);
	const second = snapshot(dbPath);
	assert.equal(second.tables.remote_resources.rootpage, first.tables.remote_resources.rootpage);
	assert.equal(second.tables.catalog_sync_roles.rootpage, first.tables.catalog_sync_roles.rootpage);
});
