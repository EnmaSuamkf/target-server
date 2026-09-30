/**
 * Operator API for scheduled series (D15–D22): create a remote workflow with a
 * schedule, PUT/DELETE its schedule, list series with their instances. Runs in
 * multi-org mode so the same file proves org isolation.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { outboxDir } from "../mailer.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-rwf-schedule-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "default.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_MULTI_ORG = "1";
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
process.env.TARGET_SUPERUSER_EMAIL = "sched-su@example.com";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const SCHEDULE_COMMANDS = ["workflow.set_schedule", "workflow.cancel_schedule"];
const DAILY = { spec: { kind: "daily", time: "09:00" }, timezone: "Europe/Madrid" };

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
	body: body == null ? undefined : JSON.stringify(body),
});

async function call(pathname, options = {}) {
	const res = await fetch(`${base}${pathname}`, options);
	const text = await res.text();
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: res.status, body };
}

function setupTokenFromMail(email) {
	const files = fs
		.readdirSync(outboxDir())
		.filter((f) => f.endsWith(".eml"))
		.sort()
		.reverse();
	for (const f of files) {
		const text = fs.readFileSync(path.join(outboxDir(), f), "utf8");
		if (!text.includes(email)) continue;
		const m = text.match(/\/setup\?token=([A-Fa-f0-9]+)/);
		if (m) return m[1];
	}
	return null;
}

async function setupCookie(token, password) {
	assert.ok(token, "setup token missing");
	const res = await fetch(`${base}/api/auth/setup`, json("POST", { token, password }));
	assert.equal(res.status, 200, await res.clone().text());
	return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

function ed25519PublicValue() {
	const { publicKey } = generateKeyPairSync("ed25519");
	return publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
}

/** Pair a hub with the org of `cookie` and register it with `commands` as its capabilities. */
async function linkedHub(cookie, name, commands) {
	const created = await call(
		"/api/device-links/requests",
		json("POST", {
			contract_version: "device-link/v1",
			device_name: name,
			hub_version: "0.9.0",
			public_key: { algorithm: "ed25519", value: ed25519PublicValue() },
			requested_scopes: ["ingest:write", "sync:write"],
		}),
	);
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const approved = await call(`/api/device-links/requests/${created.body.request_id}/approve`, json("POST", {}, cookie));
	assert.equal(approved.status, 200, JSON.stringify(approved.body));
	const consumed = await call(`/api/device-links/requests/${created.body.request_id}/consume`, {
		method: "POST",
		headers: { authorization: `Target-Link ${created.body.polling_credential}` },
	});
	assert.equal(consumed.status, 201, JSON.stringify(consumed.body));
	const headers = {
		authorization: `Target-Device v1 ${consumed.body.device.id}.${consumed.body.device_secret}`,
		"content-type": "application/json",
	};
	const register = await call("/api/sync/register", {
		method: "POST",
		headers,
		body: JSON.stringify({ name, capabilities: { commands, runners: [{ id: "claude", installed: true }] } }),
	});
	assert.equal(register.status, 201, JSON.stringify(register.body));
	return { id: register.body.client_id, headers };
}

async function provisionOrg(suCookie, { name, slug, adminEmail, password }) {
	const created = await call("/api/platform/orgs", json("POST", { name, slug, admin_email: adminEmail }, suCookie));
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const cookie = await setupCookie(setupTokenFromMail(adminEmail), password);
	const hub = await linkedHub(cookie, `${slug} hub`, ["workflow.create", "step.add", ...SCHEDULE_COMMANDS]);
	return { cookie, hub };
}

async function limitedOperator(adminCookie, { email, name, permissions, password }) {
	const role = await call("/api/auth/roles", json("POST", { name, permissions }, adminCookie));
	assert.equal(role.status, 201, JSON.stringify(role.body));
	const invite = await call("/api/auth/users", json("POST", { email, role_id: role.body.role.id }, adminCookie));
	assert.equal(invite.status, 201, JSON.stringify(invite.body));
	const token = new URL(invite.body.invite.setupUrl).searchParams.get("token");
	return setupCookie(token, password);
}

async function createRemote(cookie, body) {
	return call("/api/sync/remote-workflows", json("POST", body, cookie));
}

async function postStatus(hub, remoteId, to) {
	const res = await call("/api/sync/events", {
		method: "POST",
		headers: hub.headers,
		body: JSON.stringify({ events: [{ id: `status-${remoteId}-${to}-${Date.now()}`, type: "workflow.status_changed", remote_id: remoteId, payload: { to } }] }),
	});
	assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function pendingTypes(cookie, remoteId) {
	const detail = await call(`/api/sync/remote-workflows/${remoteId}`, { headers: { cookie } });
	assert.equal(detail.status, 200);
	return detail.body.pending_commands.map((c) => c.type);
}

const suCookie = await setupCookie(setupTokenFromMail("sched-su@example.com"), "super-password-12");
const orgA = await provisionOrg(suCookie, {
	name: "Sched Alpha",
	slug: "sched-alpha",
	adminEmail: "admin-a@sched.example.com",
	password: "alpha-admin-pass-12",
});
const orgB = await provisionOrg(suCookie, {
	name: "Sched Beta",
	slug: "sched-beta",
	adminEmail: "admin-b@sched.example.com",
	password: "beta-admin-pass-12",
});

test("create with schedule: series created and set_schedule queued after create/context/steps", async () => {
	const template = await call(
		"/api/templates",
		json("POST", { name: "Nightly", steps: [{ description: "Collect" }, { description: "Report" }] }, orgA.cookie),
	);
	assert.equal(template.status, 201, JSON.stringify(template.body));
	const created = await createRemote(orgA.cookie, {
		client_id: orgA.hub.id,
		name: "Nightly report",
		agent: "claude",
		conversation_context: "Background.",
		template_id: template.body.template.id,
		schedule: { spec: { kind: "weekly", days: [1, 3, 5], time: "21:30" }, timezone: "Europe/Madrid", include_previous: false },
	});
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const rw = created.body.remote_workflow;
	const series = created.body.series;
	assert.equal(series.client_id, orgA.hub.id);
	assert.equal(series.name, "Nightly report");
	assert.deepEqual(series.spec, { kind: "weekly", days: [1, 3, 5], time: "21:30" });
	assert.equal(series.timezone, "Europe/Madrid");
	assert.equal(series.include_previous, false);
	assert.equal(series.state, "active");
	assert.equal(series.created_by, "server");
	assert.equal(rw.series_id, series.id);
	assert.equal(rw.created_by, "server");
	assert.equal(rw.schedule_state, null);

	const cmd = created.body.schedule_command;
	assert.equal(cmd.type, "workflow.set_schedule");
	assert.equal(cmd.remote_id, rw.id);
	assert.deepEqual(cmd.payload, {
		series_id: series.id,
		spec: { kind: "weekly", days: [1, 3, 5], time: "21:30" },
		timezone: "Europe/Madrid",
		include_previous: false,
	});
	const others = [created.body.command, created.body.context_command, ...created.body.step_commands, ...created.body.selection_commands];
	assert.ok(others.every((c) => c.sequence < cmd.sequence), "set_schedule must be the last command");
	assert.deepEqual(await pendingTypes(orgA.cookie, rw.id), [
		"workflow.create",
		"workflow.set_context",
		"step.add",
		"step.add",
		"workflow.set_schedule",
	]);

	// List and detail expose the schedule fields.
	const list = await call(`/api/sync/remote-workflows?client_id=${orgA.hub.id}`, { headers: { cookie: orgA.cookie } });
	const listed = list.body.remote_workflows.find((w) => w.id === rw.id);
	for (const key of ["series_id", "scheduled_for", "schedule_state", "next_run_at", "archived_at", "created_by"]) {
		assert.ok(key in listed, key);
	}
	assert.equal(listed.series_id, series.id);
	const detail = await call(`/api/sync/remote-workflows/${rw.id}`, { headers: { cookie: orgA.cookie } });
	assert.equal(detail.body.series.id, series.id);
	assert.equal(detail.body.remote_workflow.series_id, series.id);
});

test("create with an invalid schedule is refused and persists nothing", async () => {
	const before = (await call("/api/sync/remote-workflows", { headers: { cookie: orgA.cookie } })).body.remote_workflows.length;
	const bad = await createRemote(orgA.cookie, {
		client_id: orgA.hub.id,
		name: "Bad",
		schedule: { spec: { kind: "daily", time: "25:00" }, timezone: "Mars/Olympus" },
	});
	assert.equal(bad.status, 400);
	assert.deepEqual(bad.body.errors.map((e) => e.field).sort(), ["schedule.spec.time", "schedule.timezone"]);
	const after = (await call("/api/sync/remote-workflows", { headers: { cookie: orgA.cookie } })).body.remote_workflows.length;
	assert.equal(after, before);
});

test("PUT schedule creates a series, then updates it in place; DELETE cancels it", async () => {
	const created = await createRemote(orgA.cookie, { client_id: orgA.hub.id, name: "Later scheduled", agent: "claude" });
	assert.equal(created.status, 201);
	assert.equal(created.body.series, null);
	assert.equal(created.body.schedule_command, null);
	const rid = created.body.remote_workflow.id;

	const first = await call(`/api/sync/remote-workflows/${rid}/schedule`, json("PUT", DAILY, orgA.cookie));
	assert.equal(first.status, 200, JSON.stringify(first.body));
	const seriesId = first.body.series.id;
	assert.equal(first.body.series.include_previous, true);
	assert.equal(first.body.remote_workflow.series_id, seriesId);
	assert.equal(first.body.command.type, "workflow.set_schedule");
	assert.equal(first.body.command.payload.series_id, seriesId);

	const second = await call(
		`/api/sync/remote-workflows/${rid}/schedule`,
		json("PUT", { spec: { kind: "once", at: "2030-01-02T08:00" }, timezone: "UTC", include_previous: false }, orgA.cookie),
	);
	assert.equal(second.status, 200);
	assert.equal(second.body.series.id, seriesId, "same series updated, not a new one");
	assert.deepEqual(second.body.series.spec, { kind: "once", at: "2030-01-02T08:00" });
	assert.equal(second.body.series.timezone, "UTC");
	assert.equal(second.body.series.include_previous, false);
	assert.deepEqual(second.body.command.payload, {
		series_id: seriesId,
		spec: { kind: "once", at: "2030-01-02T08:00" },
		timezone: "UTC",
		include_previous: false,
	});

	const invalid = await call(`/api/sync/remote-workflows/${rid}/schedule`, json("PUT", { spec: { kind: "weekly", days: [], time: "09:00" }, timezone: "UTC" }, orgA.cookie));
	assert.equal(invalid.status, 400);

	const cancel = await call(`/api/sync/remote-workflows/${rid}/schedule`, { method: "DELETE", headers: { cookie: orgA.cookie } });
	assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
	assert.equal(cancel.body.series.state, "cancelled");
	assert.equal(cancel.body.command.type, "workflow.cancel_schedule");
	assert.deepEqual(cancel.body.command.payload, { series_id: seriesId });

	// Idempotent: nothing more to tell the hub.
	const again = await call(`/api/sync/remote-workflows/${rid}/schedule`, { method: "DELETE", headers: { cookie: orgA.cookie } });
	assert.equal(again.status, 200);
	assert.equal(again.body.command, null);

	// Scheduling a cancelled instance again starts a NEW series.
	const renewed = await call(`/api/sync/remote-workflows/${rid}/schedule`, json("PUT", DAILY, orgA.cookie));
	assert.equal(renewed.status, 200);
	assert.notEqual(renewed.body.series.id, seriesId);
	assert.equal(renewed.body.remote_workflow.series_id, renewed.body.series.id);

	const types = await pendingTypes(orgA.cookie, rid);
	assert.deepEqual(types.filter((t) => t.includes("schedule")), [
		"workflow.set_schedule",
		"workflow.set_schedule",
		"workflow.cancel_schedule",
		"workflow.set_schedule",
	]);

	const unknown = await call("/api/sync/remote-workflows/nope/schedule", json("PUT", DAILY, orgA.cookie));
	assert.equal(unknown.status, 404);
	const noSeries = await createRemote(orgA.cookie, { client_id: orgA.hub.id, name: "Never scheduled" });
	const delNone = await call(`/api/sync/remote-workflows/${noSeries.body.remote_workflow.id}/schedule`, { method: "DELETE", headers: { cookie: orgA.cookie } });
	assert.equal(delNone.status, 404);
	assert.equal(delNone.body.error, "schedule_not_found");
});

test("PUT schedule is 409 while the remote workflow is running, waiting or paused", async () => {
	const created = await createRemote(orgA.cookie, { client_id: orgA.hub.id, name: "Busy one" });
	const rid = created.body.remote_workflow.id;
	for (const status of ["running", "waiting", "paused"]) {
		await postStatus(orgA.hub, rid, status);
		const res = await call(`/api/sync/remote-workflows/${rid}/schedule`, json("PUT", DAILY, orgA.cookie));
		assert.equal(res.status, 409, status);
		assert.deepEqual(res.body, { error: "remote_workflow_busy", status });
	}
	const series = await call(`/api/sync/schedule-series?client_id=${orgA.hub.id}`, { headers: { cookie: orgA.cookie } });
	assert.ok(series.body.series.every((s) => !s.instances.some((i) => i.id === rid)));
	assert.equal((await pendingTypes(orgA.cookie, rid)).includes("workflow.set_schedule"), false);

	await postStatus(orgA.hub, rid, "completed");
	const ok = await call(`/api/sync/remote-workflows/${rid}/schedule`, json("PUT", DAILY, orgA.cookie));
	assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("409 capability_unsupported when the hub doesn't advertise the schedule commands; nothing persisted", async () => {
	const oldHub = await linkedHub(orgA.cookie, "old hub", ["workflow.create", "step.add"]);
	const before = (await call("/api/sync/remote-workflows", { headers: { cookie: orgA.cookie } })).body.remote_workflows.length;

	const create = await createRemote(orgA.cookie, { client_id: oldHub.id, name: "Old hub series", schedule: DAILY });
	assert.equal(create.status, 409);
	assert.deepEqual(create.body, {
		error: "capability_unsupported",
		detail: "Client does not support workflow.set_schedule",
		required: { command: "workflow.set_schedule" },
	});
	const after = (await call("/api/sync/remote-workflows", { headers: { cookie: orgA.cookie } })).body.remote_workflows.length;
	assert.equal(after, before, "no remote workflow created");

	const plain = await createRemote(orgA.cookie, { client_id: oldHub.id, name: "Old hub plain" });
	assert.equal(plain.status, 201);
	const rid = plain.body.remote_workflow.id;
	const put = await call(`/api/sync/remote-workflows/${rid}/schedule`, json("PUT", DAILY, orgA.cookie));
	assert.equal(put.status, 409);
	assert.equal(put.body.error, "capability_unsupported");
	assert.equal((await call(`/api/sync/remote-workflows/${rid}`, { headers: { cookie: orgA.cookie } })).body.remote_workflow.series_id, null);
	assert.deepEqual(await pendingTypes(orgA.cookie, rid), ["workflow.create"]);
	const series = await call(`/api/sync/schedule-series?client_id=${oldHub.id}`, { headers: { cookie: orgA.cookie } });
	assert.deepEqual(series.body.series, []);
});

test("scheduling needs client.workflows.execute AND client.workflows.manage", async () => {
	const noExecute = await limitedOperator(orgA.cookie, {
		email: "no-exec@sched.example.com",
		name: "Manage only",
		permissions: ["client.read", "client.workflows.create", "client.workflows.manage"],
		password: "no-exec-pass-12345",
	});
	const noManage = await limitedOperator(orgA.cookie, {
		email: "no-manage@sched.example.com",
		name: "Execute only",
		permissions: ["client.read", "client.workflows.create", "client.workflows.execute"],
		password: "no-manage-pass-1234",
	});
	const before = (await call("/api/sync/remote-workflows", { headers: { cookie: orgA.cookie } })).body.remote_workflows.length;

	const c1 = await createRemote(noExecute, { client_id: orgA.hub.id, name: "x", schedule: DAILY });
	assert.equal(c1.status, 403);
	assert.deepEqual(c1.body, { error: "forbidden", permission: "client.workflows.execute" });
	const c2 = await createRemote(noManage, { client_id: orgA.hub.id, name: "x", schedule: DAILY });
	assert.equal(c2.status, 403);
	assert.deepEqual(c2.body, { error: "forbidden", permission: "client.workflows.manage" });
	const after = (await call("/api/sync/remote-workflows", { headers: { cookie: orgA.cookie } })).body.remote_workflows.length;
	assert.equal(after, before);

	// Without a schedule the same user can still create.
	const plain = await createRemote(noExecute, { client_id: orgA.hub.id, name: "Plain by manager" });
	assert.equal(plain.status, 201);
	const rid = plain.body.remote_workflow.id;
	for (const cookie of [noExecute, noManage]) {
		assert.equal((await call(`/api/sync/remote-workflows/${rid}/schedule`, json("PUT", DAILY, cookie))).status, 403);
		assert.equal((await call(`/api/sync/remote-workflows/${rid}/schedule`, { method: "DELETE", headers: { cookie } })).status, 403);
	}
	assert.equal((await call(`/api/sync/remote-workflows/${rid}`, { headers: { cookie: orgA.cookie } })).body.remote_workflow.series_id, null);

	// Nor through the generic command route.
	const raw = await call(
		`/api/sync/remote-workflows/${rid}/commands`,
		json("POST", { type: "workflow.set_schedule", payload: { series_id: "s", ...DAILY } }, orgA.cookie),
	);
	assert.equal(raw.status, 422);
	assert.equal(raw.body.errors[0].code, "use_schedule_endpoint");
});

test("GET /api/sync/schedule-series lists series with their instances", async () => {
	const created = await createRemote(orgA.cookie, { client_id: orgA.hub.id, name: "Listed", schedule: DAILY });
	assert.equal(created.status, 201);
	const all = await call("/api/sync/schedule-series", { headers: { cookie: orgA.cookie } });
	assert.equal(all.status, 200);
	const entry = all.body.series.find((s) => s.id === created.body.series.id);
	assert.equal(entry.name, "Listed");
	assert.deepEqual(entry.spec, DAILY.spec);
	assert.equal(entry.timezone, DAILY.timezone);
	assert.deepEqual(entry.instances.map((i) => i.id), [created.body.remote_workflow.id]);
	assert.equal(entry.instances[0].series_id, entry.id);

	const filtered = await call(`/api/sync/schedule-series?client_id=${orgA.hub.id}`, { headers: { cookie: orgA.cookie } });
	assert.ok(filtered.body.series.length >= 1);
	assert.ok(filtered.body.series.every((s) => s.client_id === orgA.hub.id));
	const none = await call("/api/sync/schedule-series?client_id=cli_unknown", { headers: { cookie: orgA.cookie } });
	assert.deepEqual(none.body.series, []);
	assert.equal((await call("/api/sync/schedule-series")).status, 401);
});

test("org isolation: org B neither sees nor changes org A's series", async () => {
	const a = await createRemote(orgA.cookie, { client_id: orgA.hub.id, name: "Alpha private", schedule: DAILY });
	assert.equal(a.status, 201);
	const rid = a.body.remote_workflow.id;

	const listB = await call("/api/sync/schedule-series", { headers: { cookie: orgB.cookie } });
	assert.equal(listB.status, 200);
	assert.deepEqual(listB.body.series, []);
	const listBA = await call(`/api/sync/schedule-series?client_id=${orgA.hub.id}`, { headers: { cookie: orgB.cookie } });
	assert.deepEqual(listBA.body.series, []);

	assert.equal((await call(`/api/sync/remote-workflows/${rid}/schedule`, json("PUT", DAILY, orgB.cookie))).status, 404);
	assert.equal((await call(`/api/sync/remote-workflows/${rid}/schedule`, { method: "DELETE", headers: { cookie: orgB.cookie } })).status, 404);
	// Org B can't schedule onto org A's hub either.
	const cross = await createRemote(orgB.cookie, { client_id: orgA.hub.id, name: "Cross", schedule: DAILY });
	assert.equal(cross.status, 404);

	// Org B's own series stay in org B.
	const b = await createRemote(orgB.cookie, { client_id: orgB.hub.id, name: "Beta own", schedule: DAILY });
	assert.equal(b.status, 201);
	const listA = await call("/api/sync/schedule-series", { headers: { cookie: orgA.cookie } });
	assert.ok(listA.body.series.every((s) => s.id !== b.body.series.id));
	assert.ok(listA.body.series.some((s) => s.id === a.body.series.id));
	const stillActive = listA.body.series.find((s) => s.id === a.body.series.id);
	assert.equal(stillActive.state, "active");
});
