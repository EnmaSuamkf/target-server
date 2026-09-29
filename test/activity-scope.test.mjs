/**
 * Activity dashboard scope: `activity.read` sees every hub; `activity.read.own`
 * is pinned to events/instances whose owner_user_id is the caller. A shared
 * workflow_id must not leak another account's plan, notes, usage or status.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { login } from "./helpers.mjs";
import { hashPassword } from "../auth.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-activity-scope-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const NOW = "2026-06-01T12:00:00.000Z";
const WF_A = "wf-aaaaaaaa";
const WF_B = "wf-bbbbbbbb";
const WF_ORPHAN = "wf-orphan00";
const WF_LEAK = "wf-leaked00";
const SECRET_NAME = "Secret Bravo";
const SECRET_STEP = "do not leak";
const SECRET_NOTE = "B private note";
const PASSWORD = "scope-password-12";

const INST_A = "inst-owner-a";
const INST_B = "inst-owner-b";
const INST_ORPHAN = "inst-orphan";

let ownCookie;
let allCookie;
let bothCookie;
let noneCookie;
let adminCookie;
let userA;

function json(pathname, cookie) {
	return fetch(`${base}${pathname}`, { headers: cookie ? { cookie } : {} });
}

function event(id, kind, workflowId, data = {}) {
	return { id, kind, workflow_id: workflowId, created_at: NOW, data };
}

function seedOwned(instanceId, displayName, device, rows) {
	db.upsertInstance({ instance_id: instanceId, version: "0.2.0", user: { display_name: displayName } }, NOW, device);
	for (const row of rows) db.insertEvent(instanceId, "0.2.0", row, NOW, device);
}

async function userWithRole(email, permissions) {
	const role = db.createRole({ name: `role-${email}`, permissions });
	const user = db.createAuthUser({ email, roleId: role.id });
	db.setUserPassword(user.id, await hashPassword(PASSWORD));
	return user;
}

before(async () => {
	userA = await userWithRole("own@example.com", ["activity.read.own"]);
	const userB = await userWithRole("other@example.com", ["activity.read.own"]);
	await userWithRole("all@example.com", ["activity.read"]);
	await userWithRole("both@example.com", ["activity.read", "activity.read.own"]);
	await userWithRole("none@example.com", []);

	const deviceA = { id: "dev-a", ownerUserId: userA.id };
	const deviceB = { id: "dev-b", ownerUserId: userB.id };

	seedOwned(INST_A, "Ada", deviceA, [
		event("a-created", "workflow.created", WF_A, { name: "Alpha", agent: "agent-a", sandbox: "docker" }),
		event("a-plan", "workflow.plan", WF_A, {
			name: "Alpha",
			status: "running",
			steps: [{ step_id: "a-step", order_index: 0, description: "A work", status: "running" }],
		}),
		event("a-usage", "usage.snapshot", WF_A, { input_tokens: 10, output_tokens: 2 }),
		// Stray event on B's leaked workflow_id — must not pull B's history.
		event("a-leak", "step.started", WF_LEAK, { step_id: "a-only-step" }),
	]);

	seedOwned(INST_B, "Bea", deviceB, [
		event("b-created", "workflow.created", WF_B, { name: "Bravo", agent: "agent-b", sandbox: "ssh" }),
		event("b-plan", "workflow.plan", WF_B, {
			name: "Bravo",
			status: "running",
			steps: [{ step_id: "b-step", order_index: 0, description: "B work", status: "running" }],
		}),
		event("b-leak-created", "workflow.created", WF_LEAK, { name: SECRET_NAME, agent: "agent-b", sandbox: "ssh" }),
		event("b-leak-plan", "workflow.plan", WF_LEAK, {
			name: SECRET_NAME,
			status: "completed",
			steps: [{ step_id: "b-secret-step", order_index: 0, description: SECRET_STEP, status: "done" }],
		}),
		event("b-leak-note", "step.note.added", WF_LEAK, {
			step_id: "b-secret-step",
			note_id: "note-b",
			theme: "warning",
			content: SECRET_NOTE,
		}),
		event("b-leak-usage", "usage.snapshot", WF_LEAK, { input_tokens: 99999, output_tokens: 50 }),
		event("b-leak-status", "workflow.status_changed", WF_LEAK, { to: "completed" }),
	]);

	seedOwned(INST_ORPHAN, "OrphanUser", null, [
		event("o-created", "workflow.created", WF_ORPHAN, { name: "Orphan", agent: "agent-orphan", sandbox: "none" }),
		event("o-plan", "workflow.plan", WF_ORPHAN, {
			name: "Orphan",
			status: "draft",
			steps: [{ step_id: "o-step", order_index: 0, description: "unowned work", status: "pending" }],
		}),
	]);

	ownCookie = await login(base, { email: "own@example.com", password: PASSWORD });
	allCookie = await login(base, { email: "all@example.com", password: PASSWORD });
	bothCookie = await login(base, { email: "both@example.com", password: PASSWORD });
	noneCookie = await login(base, { email: "none@example.com", password: PASSWORD });
	adminCookie = await login(base);
});

function assertOwnIsolation(body) {
	const blob = JSON.stringify(body);
	assert.equal(blob.includes("Bravo"), false);
	assert.equal(blob.includes("Bea"), false);
	assert.equal(blob.includes("Orphan"), false);
	assert.equal(blob.includes("OrphanUser"), false);
	assert.equal(blob.includes(SECRET_NAME), false);
	assert.equal(blob.includes(SECRET_STEP), false);
	assert.equal(blob.includes(SECRET_NOTE), false);
	assert.equal(blob.includes("agent-b"), false);
	assert.equal(blob.includes("agent-orphan"), false);
}

test("activity.read.own sees only the caller's hubs, not others or unowned rows", async () => {
	const eventsRes = await json("/api/events?limit=100", ownCookie);
	assert.equal(eventsRes.status, 200);
	const eventsBody = await eventsRes.json();
	const eventIds = eventsBody.events.map((e) => e.id).sort();
	assert.deepEqual(eventIds, ["a-created", "a-leak", "a-plan", "a-usage"]);
	assertOwnIsolation(eventsBody);

	const wfRes = await json("/api/workflows", ownCookie);
	assert.equal(wfRes.status, 200);
	const wfBody = await wfRes.json();
	const wfIds = wfBody.workflows.map((w) => w.workflowId).sort();
	assert.ok(wfIds.includes(WF_A));
	assert.equal(wfIds.includes(WF_B), false);
	assert.equal(wfIds.includes(WF_ORPHAN), false);
	assertOwnIsolation(wfBody);

	const namesRes = await json("/api/workflows/names", ownCookie);
	assert.equal(namesRes.status, 200);
	const namesBody = await namesRes.json();
	const named = namesBody.workflows.map((w) => w.workflowId).sort();
	assert.ok(named.includes(WF_A));
	assert.equal(named.includes(WF_B), false);
	assert.equal(named.includes(WF_ORPHAN), false);
	assertOwnIsolation(namesBody);

	const statsRes = await json("/api/stats", ownCookie);
	assert.equal(statsRes.status, 200);
	const stats = await statsRes.json();
	assert.equal(stats.totalEvents, 4);
	assert.equal(stats.totalInstances, 1);
	assert.deepEqual(stats.agents, ["agent-a"]);
	assert.deepEqual(stats.sandboxes, ["docker"]);
	assertOwnIsolation(stats);

	const instRes = await json("/api/instances", ownCookie);
	assert.equal(instRes.status, 200);
	const instBody = await instRes.json();
	assert.deepEqual(
		instBody.instances.map((i) => i.instanceId),
		[INST_A],
	);
	assertOwnIsolation(instBody);

	const usersRes = await json("/api/users", ownCookie);
	assert.equal(usersRes.status, 200);
	const usersBody = await usersRes.json();
	assert.deepEqual(
		usersBody.users.map((u) => u.name),
		["Ada"],
	);
	assertOwnIsolation(usersBody);
});

test("activity.read.own gets 404 for another account's workflow id", async () => {
	const res = await json(`/api/workflows/${WF_B}`, ownCookie);
	assert.equal(res.status, 404);
	assert.deepEqual(await res.json(), { error: "unknown_workflow" });
});

test("reusing another account's workflow_id does not leak that account's history", async () => {
	const res = await json(`/api/workflows/${WF_LEAK}`, ownCookie);
	assert.equal(res.status, 200);
	const detail = await res.json();
	assert.notEqual(detail.workflow.name, SECRET_NAME);
	assert.equal(detail.workflow.hasPlan, false);
	assert.notEqual(detail.workflow.status, "completed");
	assert.equal(detail.usage.inputTokens, 0);
	assert.equal(JSON.stringify(detail).includes(SECRET_STEP), false);
	assert.equal(JSON.stringify(detail).includes(SECRET_NOTE), false);
	assert.equal(
		detail.steps.some((s) => s.description === SECRET_STEP),
		false,
	);
});

async function assertSeesEverything(cookie) {
	const events = await (await json("/api/events?limit=100", cookie)).json();
	const ids = new Set(events.events.map((e) => e.id));
	assert.ok(ids.has("a-created"));
	assert.ok(ids.has("b-created"));
	assert.ok(ids.has("o-created"));
	assert.ok(ids.has("b-leak-note"));

	const workflows = await (await json("/api/workflows", cookie)).json();
	const wfIds = new Set(workflows.workflows.map((w) => w.workflowId));
	assert.ok(wfIds.has(WF_A));
	assert.ok(wfIds.has(WF_B));
	assert.ok(wfIds.has(WF_ORPHAN));
	assert.ok(wfIds.has(WF_LEAK));
	const leak = workflows.workflows.find((w) => w.workflowId === WF_LEAK);
	assert.equal(leak.name, SECRET_NAME);

	const names = await (await json("/api/workflows/names", cookie)).json();
	assert.ok(names.workflows.some((w) => w.name === "Orphan"));

	const stats = await (await json("/api/stats", cookie)).json();
	assert.ok(stats.totalEvents >= 13);
	assert.equal(stats.totalInstances, 3);
	assert.ok(stats.agents.includes("agent-b"));
	assert.ok(stats.agents.includes("agent-orphan"));

	const instances = await (await json("/api/instances", cookie)).json();
	const instIds = instances.instances.map((i) => i.instanceId).sort();
	assert.deepEqual(instIds, [INST_A, INST_B, INST_ORPHAN].sort());

	const users = await (await json("/api/users", cookie)).json();
	const userNames = users.users.map((u) => u.name).sort();
	assert.deepEqual(userNames, ["Ada", "Bea", "OrphanUser"]);

	const detail = await (await json(`/api/workflows/${WF_LEAK}`, cookie)).json();
	assert.equal(detail.workflow.name, SECRET_NAME);
	assert.equal(detail.workflow.hasPlan, true);
	assert.ok(detail.steps.some((s) => s.description === SECRET_STEP));
	assert.ok(detail.steps.some((s) => (s.notes ?? []).some((n) => n.content === SECRET_NOTE)));
}

test("activity.read alone sees every hub, including unowned events", async () => {
	assert.equal((await json("/api/stats", allCookie)).status, 200);
	await assertSeesEverything(allCookie);
});

test("activity.read plus activity.read.own still sees every hub", async () => {
	await assertSeesEverything(bothCookie);
});

test("a role with neither activity permission is 403 with activity.read.own", async () => {
	for (const pathname of ["/api/stats", "/api/events", "/api/workflows", `/api/workflows/${WF_A}`]) {
		const res = await json(pathname, noneCookie);
		assert.equal(res.status, 403);
		assert.deepEqual(await res.json(), { error: "forbidden", permission: "activity.read.own" });
	}
});

test("the admin role includes activity.read.own", async () => {
	const me = await (await json("/api/auth/me", adminCookie)).json();
	assert.ok(me.user.permissions.includes("activity.read.own"));
	assert.ok(me.user.permissions.includes("activity.read"));
	const activity = me.catalog.groups.find((group) => group.id === "server.activity");
	assert.ok(activity.permissions.some((p) => p.id === "activity.read.own"));
});

test("a database whose CHECK predates activity.read.own migrates and then accepts the id", () => {
	const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-activity-scope-mig-")), "legacy.db");
	const legacy = new DatabaseSync(dbPath);
	legacy.exec(`
		CREATE TABLE auth_users (
			id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'admin',
			token_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_by TEXT, invited_at TEXT,
			activated_at TEXT, last_login_at TEXT
		);
		CREATE TABLE auth_roles (
			id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_system INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE auth_role_permissions (
			role_id TEXT NOT NULL,
			permission TEXT NOT NULL CHECK (permission IN (
				'activity.read', 'users.read', 'users.manage'
			)),
			PRIMARY KEY (role_id, permission)
		);
	`);
	legacy.close();

	const dbUrl = new URL("../db.mjs", import.meta.url).href;
	const script = `
		process.env.TARGET_SERVER_DB = ${JSON.stringify(dbPath)};
		const db = await import(${JSON.stringify(dbUrl)});
		db.open(process.env.TARGET_SERVER_DB);
		const sql = db.open().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auth_role_permissions'").get().sql;
		if (!sql.includes("'activity.read.own'")) throw new Error("CHECK was not widened");
		const role = db.createRole({ name: "Migrated own", permissions: ["activity.read.own"] });
		if (!role.permissions.includes("activity.read.own")) throw new Error("createRole rejected activity.read.own");
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
	assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});
