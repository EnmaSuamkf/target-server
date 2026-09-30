/**
 * Storage for scheduled series (D21): remote_schedule_series plus the schedule
 * columns on remote_workflows. Starts from a pre-series database file so the
 * additive migration is exercised against real legacy rows, then reopens it to
 * prove the migration is idempotent, and checks a second (per-org) database.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-series-db-"));
const tmpDb = path.join(tmpDir, "t.db");
process.env.TARGET_SERVER_DB = tmpDb;

// A database as it looked before series existed: remote_workflows without any
// schedule column, holding one operator-created workflow.
{
	const legacy = new DatabaseSync(tmpDb);
	legacy.exec(`
		CREATE TABLE remote_workflows (
			id                   TEXT PRIMARY KEY,
			client_id            TEXT NOT NULL,
			name                 TEXT,
			status               TEXT,
			local_id             TEXT,
			conversation_context TEXT,
			sandbox              TEXT NOT NULL DEFAULT 'docker',
			created_at           TEXT NOT NULL
		);
		INSERT INTO remote_workflows (id, client_id, name, status, created_at)
		VALUES ('rwf_legacy', 'cli_a', 'Legacy', 'pending', '2026-01-01T00:00:00.000Z');
	`);
	legacy.close();
}

const db = await import("../db.mjs");
const {
	open,
	closeOrgDbByPath,
	runWithOrg,
	createRemoteWorkflow,
	getRemoteWorkflowById,
	listRemoteWorkflows,
	createSeries,
	getSeries,
	updateSeries,
	listSeriesByClient,
	setRemoteWorkflowScheduleFields,
} = db;
open(tmpDb);

const SERIES_COLUMNS = ["series_id", "scheduled_for", "schedule_state", "next_run_at", "archived_at", "created_by"];

function columns(handle, table) {
	return handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

test("migration adds the series table and schedule columns to a legacy database", () => {
	const handle = open();
	const cols = columns(handle, "remote_workflows");
	for (const c of SERIES_COLUMNS) assert.ok(cols.includes(c), `remote_workflows.${c} missing`);
	assert.deepEqual(columns(handle, "remote_schedule_series"), [
		"id",
		"client_id",
		"name",
		"spec_json",
		"timezone",
		"include_previous",
		"state",
		"created_by",
		"created_at",
		"updated_at",
	]);
	const legacy = getRemoteWorkflowById("rwf_legacy");
	assert.equal(legacy.name, "Legacy");
	assert.equal(legacy.seriesId, null);
	assert.equal(legacy.scheduleState, null);
	assert.equal(legacy.archivedAt, null);
	// Rows that predate series were all created by an operator here.
	assert.equal(legacy.createdBy, "server");
});

test("reopening an already migrated database is a no-op (idempotent)", () => {
	createSeries({ id: "ser_keep", clientId: "cli_a", name: "Keep", spec: { kind: "daily", time: "09:00" }, timezone: "UTC" });
	closeOrgDbByPath(tmpDb);
	const handle = open();
	assert.equal(columns(handle, "remote_workflows").filter((c) => c === "series_id").length, 1);
	assert.equal(getSeries("ser_keep").name, "Keep");
	assert.equal(getRemoteWorkflowById("rwf_legacy").name, "Legacy");
	// And once more, to be sure a second pass over existing columns doesn't throw.
	closeOrgDbByPath(tmpDb);
	open();
	assert.equal(getSeries("ser_keep").spec.time, "09:00");
});

test("createSeries / getSeries round-trip with defaults", () => {
	const s = createSeries({
		clientId: "cli_a",
		name: "Nightly report",
		spec: { kind: "weekly", days: [1, 3, 5], time: "21:30" },
		timezone: "Europe/Madrid",
		createdBy: "usr_1",
		createdAt: "2026-09-01T10:00:00.000Z",
	});
	assert.match(s.id, /^[0-9a-f-]{36}$/);
	assert.deepEqual(s, {
		id: s.id,
		clientId: "cli_a",
		name: "Nightly report",
		spec: { kind: "weekly", days: [1, 3, 5], time: "21:30" },
		timezone: "Europe/Madrid",
		includePrevious: true,
		state: "active",
		createdBy: "usr_1",
		createdAt: "2026-09-01T10:00:00.000Z",
		updatedAt: "2026-09-01T10:00:00.000Z",
	});
	assert.equal(getSeries("does-not-exist"), null);
	assert.throws(
		() => createSeries({ clientId: "cli_a", name: "x", spec: { kind: "daily", time: "09:00" }, timezone: "UTC", state: "paused" }),
		{ code: "invalid_series_state" },
	);
	assert.throws(() => createSeries({ id: s.id, clientId: "cli_a", name: "dup", spec: {}, timezone: "UTC" }));
});

test("updateSeries patches only the given keys and moves updated_at", () => {
	const s = createSeries({
		id: "ser_upd",
		clientId: "cli_a",
		name: "Before",
		spec: { kind: "daily", time: "08:00" },
		timezone: "UTC",
		createdAt: "2026-09-01T00:00:00.000Z",
	});
	const u = updateSeries(
		s.id,
		{ spec: { kind: "once", at: "2026-12-24T18:00" }, timezone: "America/New_York", includePrevious: false },
		{ updatedAt: "2026-09-02T00:00:00.000Z" },
	);
	assert.equal(u.name, "Before");
	assert.deepEqual(u.spec, { kind: "once", at: "2026-12-24T18:00" });
	assert.equal(u.timezone, "America/New_York");
	assert.equal(u.includePrevious, false);
	assert.equal(u.state, "active");
	assert.equal(u.createdAt, "2026-09-01T00:00:00.000Z");
	assert.equal(u.updatedAt, "2026-09-02T00:00:00.000Z");

	assert.equal(updateSeries(s.id, { state: "cancelled", name: "After" }).state, "cancelled");
	assert.equal(getSeries(s.id).name, "After");
	assert.throws(() => updateSeries(s.id, { state: "nope" }), { code: "invalid_series_state" });
	assert.equal(updateSeries("missing", { name: "x" }), null);
});

test("listSeriesByClient returns only that client's series, newest first", () => {
	createSeries({ id: "ser_b1", clientId: "cli_b", name: "B1", spec: { kind: "daily", time: "01:00" }, timezone: "UTC", createdAt: "2026-09-10T00:00:00.000Z" });
	createSeries({ id: "ser_b2", clientId: "cli_b", name: "B2", spec: { kind: "daily", time: "02:00" }, timezone: "UTC", createdAt: "2026-09-11T00:00:00.000Z" });
	createSeries({ id: "ser_c1", clientId: "cli_c", name: "C1", spec: { kind: "daily", time: "03:00" }, timezone: "UTC" });
	assert.deepEqual(listSeriesByClient("cli_b").map((s) => s.id), ["ser_b2", "ser_b1"]);
	assert.deepEqual(listSeriesByClient("cli_c").map((s) => s.id), ["ser_c1"]);
	assert.deepEqual(listSeriesByClient("cli_none"), []);
});

test("setRemoteWorkflowScheduleFields patches, clears and validates schedule columns", () => {
	const rw = createRemoteWorkflow({ id: "rwf_inst_1", clientId: "cli_b", name: "Instance 1" });
	assert.equal(rw.createdBy, "server");
	assert.equal(rw.seriesId, null);

	const armed = setRemoteWorkflowScheduleFields(rw.id, {
		seriesId: "ser_b1",
		scheduleState: "armed",
		nextRunAt: "2026-10-01T07:00:00.000Z",
	});
	assert.equal(armed.seriesId, "ser_b1");
	assert.equal(armed.scheduleState, "armed");
	assert.equal(armed.nextRunAt, "2026-10-01T07:00:00.000Z");
	assert.equal(armed.scheduledFor, null);

	// Undefined keys stay; null clears.
	const fired = setRemoteWorkflowScheduleFields(rw.id, {
		scheduleState: "fired",
		scheduledFor: "2026-10-01T07:00:00.000Z",
		nextRunAt: null,
	});
	assert.equal(fired.seriesId, "ser_b1");
	assert.equal(fired.scheduleState, "fired");
	assert.equal(fired.scheduledFor, "2026-10-01T07:00:00.000Z");
	assert.equal(fired.nextRunAt, null);

	const archived = setRemoteWorkflowScheduleFields(rw.id, { archivedAt: "2026-11-01T00:00:00.000Z", createdBy: "hub" });
	assert.equal(archived.archivedAt, "2026-11-01T00:00:00.000Z");
	assert.equal(archived.createdBy, "hub");
	assert.equal(setRemoteWorkflowScheduleFields(rw.id, { archivedAt: null }).archivedAt, null);

	// No keys → current row, unchanged.
	assert.equal(setRemoteWorkflowScheduleFields(rw.id, {}).scheduleState, "fired");
	assert.equal(setRemoteWorkflowScheduleFields("rwf_missing", { scheduleState: "armed" }), null);
	assert.throws(() => setRemoteWorkflowScheduleFields(rw.id, { scheduleState: "running" }), { code: "invalid_schedule_state" });
	assert.throws(() => setRemoteWorkflowScheduleFields(rw.id, { createdBy: "someone" }), { code: "invalid_created_by" });
	assert.throws(() => setRemoteWorkflowScheduleFields(rw.id, { createdBy: null }), { code: "invalid_created_by" });

	const listed = listRemoteWorkflows({ clientId: "cli_b" }).find((w) => w.id === rw.id);
	assert.equal(listed.seriesId, "ser_b1");
	assert.equal(listed.createdBy, "hub");
});

test("per-org databases get the same schema and keep series isolated", () => {
	const orgDb = path.join(tmpDir, "org-b.db");
	runWithOrg(
		"org_b",
		() => {
			const handle = open();
			for (const c of SERIES_COLUMNS) assert.ok(columns(handle, "remote_workflows").includes(c));
			assert.ok(columns(handle, "remote_schedule_series").includes("spec_json"));
			createSeries({ id: "ser_org_b", clientId: "cli_b", name: "Org B", spec: { kind: "daily", time: "05:00" }, timezone: "UTC" });
			assert.deepEqual(listSeriesByClient("cli_b").map((s) => s.id), ["ser_org_b"]);
		},
		{ dbPath: orgDb },
	);
	// The default org never sees org B's series.
	assert.equal(getSeries("ser_org_b"), null);
	assert.ok(listSeriesByClient("cli_b").every((s) => s.id !== "ser_org_b"));
});
