/**
 * Two-organization isolation: every operator/hub route family must refuse
 * to read, list, modify or enumerate the other org's rows.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { outboxDir } from "../mailer.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-org-isolation-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "default.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_MULTI_ORG = "1";
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
process.env.TARGET_SUPERUSER_EMAIL = "iso-su@example.com";

const { server } = await import("../server.mjs");
const control = await import("../control-plane.mjs");
const db = await import("../db.mjs");
const { signJwt } = await import("../auth.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const HUB_CAPABILITIES = {
	commands: [
		"workflow.create",
		"workflow.delete",
		"workflow.start",
		"step.add",
		"template.upsert",
		"template.delete",
		"tcp-tool.upsert",
		"tcp-tool.delete",
		"resource-set.upsert",
		"resource-set.delete",
	],
	runners: [{ id: "claude", installed: true }],
	resources: { version: 2, templates: true, tcp_tools: true, resource_sets: true },
};

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

function mailForEmail(email) {
	return readdirSync(outboxDir())
		.filter((f) => f.endsWith(".eml"))
		.sort()
		.reverse()
		.map((f) => readFileSync(path.join(outboxDir(), f), "utf8"))
		.filter((t) => t.includes(email));
}

function setupTokenFromMail(email) {
	for (const text of mailForEmail(email)) {
		const m = text.match(/\/setup\?token=([A-Fa-f0-9]+)/);
		if (m) return m[1];
	}
	return null;
}

function decodeJwt(cookieHeader) {
	const jwt = decodeURIComponent(cookieHeader.match(/target_auth=([^;]+)/)?.[1] ?? "");
	return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

function cookieJwt(cookieHeader) {
	return decodeURIComponent(cookieHeader.match(/target_auth=([^;]+)/)?.[1] ?? "");
}

function ed25519PublicValue() {
	const { publicKey } = generateKeyPairSync("ed25519");
	return publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
}

function countEvents(dbPath) {
	const handle = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return handle.prepare("SELECT COUNT(*) AS n FROM events").get().n;
	} finally {
		handle.close();
	}
}

function eventIds(dbPath) {
	const handle = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return handle.prepare("SELECT id FROM events ORDER BY id").all().map((row) => row.id);
	} finally {
		handle.close();
	}
}

function dump(value) {
	return JSON.stringify(value);
}

async function setupCookie(email, password) {
	const token = setupTokenFromMail(email);
	assert.ok(token, `setup token missing for ${email}`);
	const res = await fetch(`${base}/api/auth/setup`, json("POST", { token, password }));
	const body = await res.json();
	assert.equal(res.status, 200, dump(body));
	return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0], body };
}

async function superuserCookie() {
	const token = setupTokenFromMail("iso-su@example.com");
	assert.ok(token, "superuser setup token missing");
	const res = await fetch(`${base}/api/auth/setup`, json("POST", { token, password: "super-password-12" }));
	if (res.status === 409) {
		const login = await fetch(
			`${base}/api/auth/login`,
			json("POST", { email: "iso-su@example.com", password: "super-password-12" }),
		);
		assert.equal(login.status, 200);
		return (login.headers.get("set-cookie") ?? "").split(";")[0];
	}
	assert.equal(res.status, 200, await res.text());
	return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function linkAndConsumeHub(cookie, name) {
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
	assert.equal(created.status, 201, dump(created.body));
	const approved = await call(
		`/api/device-links/requests/${created.body.request_id}/approve`,
		json("POST", {}, cookie),
	);
	assert.equal(approved.status, 200, dump(approved.body));
	const consumed = await call(`/api/device-links/requests/${created.body.request_id}/consume`, {
		method: "POST",
		headers: { authorization: `Target-Link ${created.body.polling_credential}` },
	});
	assert.equal(consumed.status, 201, dump(consumed.body));
	return {
		requestId: created.body.request_id,
		deviceId: consumed.body.device.id,
		deviceSecret: consumed.body.device_secret,
		headers: {
			authorization: `Target-Device v1 ${consumed.body.device.id}.${consumed.body.device_secret}`,
			"content-type": "application/json",
		},
	};
}

async function approveExtraRequest(cookie, name) {
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
	assert.equal(created.status, 201, dump(created.body));
	const approved = await call(
		`/api/device-links/requests/${created.body.request_id}/approve`,
		json("POST", {}, cookie),
	);
	assert.equal(approved.status, 200, dump(approved.body));
	return created.body.request_id;
}

async function provisionOrg(suCookie, { name, slug, adminEmail, password, marker }) {
	const created = await call(
		"/api/platform/orgs",
		json("POST", { name, slug, admin_email: adminEmail }, suCookie),
	);
	assert.equal(created.status, 201, dump(created.body));
	const { cookie, body } = await setupCookie(adminEmail, password);
	assert.equal(body.user.email, adminEmail);

	const extraRole = await call(
		"/api/auth/roles",
		json("POST", { name: `${marker} extra role`, permissions: ["activity.read"] }, cookie),
	);
	assert.equal(extraRole.status, 201, dump(extraRole.body));
	const extraUser = await call(
		"/api/auth/users",
		json("POST", { email: `extra-${slug}@isolation.example.com`, role_id: extraRole.body.role.id }, cookie),
	);
	assert.equal(extraUser.status, 201, dump(extraUser.body));

	const tcp = await call(
		"/api/tcps",
		json(
			"POST",
			{
				name: `${marker} tcp`,
				tools: [{ name: "echo", requestTemplate: "echo hi" }],
				syncRoleIds: ["admin"],
			},
			cookie,
		),
	);
	assert.equal(tcp.status, 201, dump(tcp.body));
	const resourceSet = await call(
		"/api/resource-sets",
		json(
			"POST",
			{
				name: `${marker} rci`,
				resources: [{ name: "guide", kind: "doc", content: "# hi" }],
				syncRoleIds: ["admin"],
			},
			cookie,
		),
	);
	assert.equal(resourceSet.status, 201, dump(resourceSet.body));
	const template = await call(
		"/api/templates",
		json(
			"POST",
			{
				name: `${marker} template`,
				steps: [{ description: `Work for ${marker}` }],
				syncRoleIds: ["admin"],
			},
			cookie,
		),
	);
	assert.equal(template.status, 201, dump(template.body));

	const hub = await linkAndConsumeHub(cookie, `${marker} hub`);
	const register = await call("/api/sync/register", {
		method: "POST",
		headers: hub.headers,
		body: JSON.stringify({ name: `${marker} hub`, capabilities: HUB_CAPABILITIES }),
	});
	assert.equal(register.status, 201, dump(register.body));
	const clientId = register.body.client_id;

	const workflowId = `wf-${slug}`;
	const eventId = `evt-${slug}-created`;
	const ingest = await call("/ingest", {
		method: "POST",
		headers: hub.headers,
		body: JSON.stringify({
			instance_id: hub.deviceId,
			version: "1",
			user: { display_name: `${marker} actor` },
			events: [
				{
					id: eventId,
					kind: "workflow.created",
					workflow_id: workflowId,
					created_at: "2026-06-01T12:00:00.000Z",
					data: { name: `${marker} workflow` },
				},
			],
		}),
	});
	assert.equal(ingest.status, 200, dump(ingest.body));
	assert.deepEqual(ingest.body.accepted, [eventId]);

	const syncEventId = `sync-${slug}-1`;
	const syncEvent = await call("/api/sync/events", {
		method: "POST",
		headers: hub.headers,
		body: JSON.stringify({
			events: [{ id: syncEventId, type: "client.heartbeat", payload: { status: "idle", marker } }],
		}),
	});
	assert.equal(syncEvent.status, 200, dump(syncEvent.body));

	const remote = await call(
		"/api/sync/remote-workflows",
		json(
			"POST",
			{ client_id: clientId, name: `${marker} remote`, agent: "claude" },
			cookie,
		),
	);
	assert.equal(remote.status, 201, dump(remote.body));

	const remoteTpl = await call(`/api/sync/clients/${clientId}/templates`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ resource: { id: `tpl-${slug}`, name: `${marker} remote tpl`, data: { steps: [] } } }),
	});
	assert.equal(remoteTpl.status, 201, dump(remoteTpl.body));

	const extraApprovedRequestId = await approveExtraRequest(cookie, `${marker} second hub`);
	const listed = control.getOrganization(created.body.org.id);

	return {
		org: created.body.org,
		dbPath: listed.dbPath,
		marker,
		admin: { id: body.user.id, email: adminEmail, cookie },
		extraUser: extraUser.body.user,
		extraRole: extraRole.body.role,
		tcp: tcp.body.tcp,
		resourceSet: resourceSet.body.resourceSet,
		template: template.body.template,
		hub,
		clientId,
		workflowId,
		eventId,
		syncEventId,
		remoteWorkflowId: remote.body.remote_workflow.id,
		remoteTemplateId: `tpl-${slug}`,
		extraApprovedRequestId,
	};
}

const suCookie = await superuserCookie();
const orgA = await provisionOrg(suCookie, {
	name: "Isolation Alpha",
	slug: "iso-alpha",
	adminEmail: "admin-a@isolation.example.com",
	password: "alpha-admin-pass-12",
	marker: "ISO-ALPHA",
});
const orgB = await provisionOrg(suCookie, {
	name: "Isolation Beta",
	slug: "iso-beta",
	adminEmail: "admin-b@isolation.example.com",
	password: "beta-admin-pass-12",
	marker: "ISO-BETA",
});

function assertNoMarker(payload, marker, label) {
	assert.equal(dump(payload).includes(marker), false, `${label} leaked ${marker}: ${dump(payload).slice(0, 500)}`);
}

async function assertIsolation(from, other) {
	const cookie = from.admin.cookie;

	const users = await call("/api/auth/users", { headers: { cookie } });
	assert.equal(users.status, 200);
	assert.ok(users.body.users.some((u) => u.email === from.admin.email));
	assert.equal(users.body.users.some((u) => u.email === other.admin.email), false);
	assert.equal(users.body.users.some((u) => u.id === other.extraUser.id), false);
	assertNoMarker(users.body, other.admin.email, "GET /api/auth/users");

	const roles = await call("/api/auth/roles", { headers: { cookie } });
	assert.equal(roles.status, 200);
	assert.equal(roles.body.roles.some((r) => r.id === other.extraRole.id), false);
	assertNoMarker(roles.body, other.extraRole.name, "GET /api/auth/roles");

	assert.equal(
		(await call(`/api/auth/users/${other.extraUser.id}`, json("PATCH", { role_id: "admin" }, cookie))).status,
		404,
	);
	assert.equal((await call(`/api/auth/users/${other.extraUser.id}`, { method: "DELETE", headers: { cookie } })).status, 404);
	assert.equal(
		(await call(`/api/auth/roles/${other.extraRole.id}`, json("PATCH", { name: "Stolen", permissions: [] }, cookie))).status,
		404,
	);
	assert.equal((await call(`/api/auth/roles/${other.extraRole.id}`, { method: "DELETE", headers: { cookie } })).status, 404);

	for (const pathname of ["/api/stats", "/api/instances", "/api/users", "/api/events", "/api/workflows", "/api/workflows/names"]) {
		const res = await call(pathname, { headers: { cookie } });
		assert.equal(res.status, 200, `${pathname} ${dump(res.body)}`);
		assertNoMarker(res.body, other.marker, pathname);
		assertNoMarker(res.body, other.workflowId, pathname);
		assertNoMarker(res.body, other.eventId, pathname);
		assertNoMarker(res.body, other.hub.deviceId, pathname);
	}

	const wf = await call(`/api/workflows/${other.workflowId}`, { headers: { cookie } });
	assert.equal(wf.status, 404);
	assert.equal(wf.body.error, "unknown_workflow");

	const devices = await call("/api/device-links/devices", { headers: { cookie } });
	assert.equal(devices.status, 200);
	assert.equal(devices.body.devices.some((d) => d.id === other.hub.deviceId), false);
	assert.ok(devices.body.devices.some((d) => d.id === from.hub.deviceId));

	const audit = await call(`/api/device-links/devices/${other.hub.deviceId}/audit`, { headers: { cookie } });
	assert.equal(audit.status, 404);
	const revoke = await call(
		`/api/device-links/devices/${other.hub.deviceId}/revoke`,
		json("POST", { reason: "cross-org" }, cookie),
	);
	assert.equal(revoke.status, 404);

	const stealApprove = await call(
		`/api/device-links/requests/${other.extraApprovedRequestId}/approve`,
		json("POST", {}, cookie),
	);
	assert.equal(stealApprove.status, 404, dump(stealApprove.body));

	const clients = await call("/api/sync/clients", { headers: { cookie } });
	assert.equal(clients.status, 200);
	assert.equal(clients.body.clients.some((c) => c.id === other.clientId), false);
	assert.ok(clients.body.clients.some((c) => c.id === from.clientId));

	const syncEvents = await call("/api/sync/events", { headers: { cookie } });
	assert.equal(syncEvents.status, 200);
	assertNoMarker(syncEvents.body, other.syncEventId, "GET /api/sync/events");
	assertNoMarker(syncEvents.body, other.marker, "GET /api/sync/events");

	const remotes = await call("/api/sync/remote-workflows", { headers: { cookie } });
	assert.equal(remotes.status, 200);
	assert.equal(remotes.body.remote_workflows.some((w) => w.id === other.remoteWorkflowId), false);
	assertNoMarker(remotes.body, other.marker, "GET /api/sync/remote-workflows");

	const remoteDetail = await call(`/api/sync/remote-workflows/${other.remoteWorkflowId}`, { headers: { cookie } });
	assert.equal(remoteDetail.status, 404);

	const createOnOther = await call(
		"/api/sync/remote-workflows",
		json("POST", { client_id: other.clientId, name: "Stolen remote", agent: "claude" }, cookie),
	);
	assert.equal(createOnOther.status, 404);
	assert.equal(createOnOther.body.error, "client_not_found");

	const cmd = await call(
		`/api/sync/remote-workflows/${other.remoteWorkflowId}/commands`,
		json("POST", { type: "workflow.start", payload: { step_keys: ["s1"] } }, cookie),
	);
	assert.equal(cmd.status, 404);
	const setTcps = await call(
		`/api/sync/remote-workflows/${other.remoteWorkflowId}/tcps`,
		json("PUT", { tcp_selections: [] }, cookie),
	);
	assert.equal(setTcps.status, 404);
	const setRci = await call(
		`/api/sync/remote-workflows/${other.remoteWorkflowId}/resource-sets`,
		json("PUT", { resource_selections: [] }, cookie),
	);
	assert.equal(setRci.status, 404);
	const delRemote = await call(`/api/sync/remote-workflows/${other.remoteWorkflowId}`, {
		method: "DELETE",
		headers: { cookie },
	});
	assert.equal(delRemote.status, 404);

	for (const domain of ["templates", "tcp-tools", "resource-sets"]) {
		const listed = await call(`/api/sync/clients/${other.clientId}/${domain}`, { headers: { cookie } });
		assert.equal(listed.status, 404, domain);
		assert.equal(listed.body.error, "client_not_found");
		const exported = await call(`/api/sync/clients/${other.clientId}/${domain}/export`, { headers: { cookie } });
		assert.equal(exported.status, 404);
		const imported = await call(`/api/sync/clients/${other.clientId}/${domain}/import`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ resources: [{ id: "x", name: "x", data: {} }] }),
		});
		assert.equal(imported.status, 404);
	}

	const templates = await call("/api/templates", { headers: { cookie } });
	assert.equal(templates.status, 200);
	assertNoMarker(templates.body, other.template.name, "GET /api/templates");
	assert.equal((await call(`/api/templates/${other.template.id}`, { headers: { cookie } })).status, 404);
	assert.equal((await call(`/api/templates/${other.template.id}`, json("PATCH", { name: "Stolen" }, cookie))).status, 404);
	assert.equal((await call(`/api/templates/${other.template.id}`, { method: "DELETE", headers: { cookie } })).status, 404);

	const tcps = await call("/api/tcps", { headers: { cookie } });
	assert.equal(tcps.status, 200);
	assertNoMarker(tcps.body, other.tcp.name, "GET /api/tcps");
	assert.equal((await call(`/api/tcps/${other.tcp.id}`, { headers: { cookie } })).status, 404);
	assert.equal((await call(`/api/tcps/${other.tcp.id}`, json("PATCH", { name: "Stolen" }, cookie))).status, 404);
	assert.equal((await call(`/api/tcps/${other.tcp.id}`, { method: "DELETE", headers: { cookie } })).status, 404);

	const sets = await call("/api/resource-sets", { headers: { cookie } });
	assert.equal(sets.status, 200);
	assertNoMarker(sets.body, other.resourceSet.name, "GET /api/resource-sets");
	assert.equal((await call(`/api/resource-sets/${other.resourceSet.id}`, { headers: { cookie } })).status, 404);
	assert.equal(
		(await call(`/api/resource-sets/${other.resourceSet.id}`, json("PATCH", { name: "Stolen" }, cookie))).status,
		404,
	);
	assert.equal((await call(`/api/resource-sets/${other.resourceSet.id}`, { method: "DELETE", headers: { cookie } })).status, 404);

	const syncRoles = await call("/api/catalog/sync-roles", { headers: { cookie } });
	assert.equal(syncRoles.status, 200);
	assertNoMarker(syncRoles.body, other.extraRole.name, "GET /api/catalog/sync-roles");

	const catalogPull = await call("/api/sync/catalog", { headers: from.hub.headers });
	assert.equal(catalogPull.status, 200, dump(catalogPull.body));
	assertNoMarker(catalogPull.body, other.template.name, "GET /api/sync/catalog");
	assertNoMarker(catalogPull.body, other.tcp.name, "GET /api/sync/catalog");
	assertNoMarker(catalogPull.body, other.resourceSet.name, "GET /api/sync/catalog");
	assert.ok(dump(catalogPull.body).includes(from.template.name));

	const otherCatalog = await call("/api/sync/catalog", { headers: other.hub.headers });
	assert.equal(otherCatalog.status, 200, dump(otherCatalog.body));
	assertNoMarker(otherCatalog.body, from.template.name, "GET /api/sync/catalog from other hub");
	assertNoMarker(otherCatalog.body, from.tcp.name, "GET /api/sync/catalog from other hub");
	assertNoMarker(otherCatalog.body, from.resourceSet.name, "GET /api/sync/catalog from other hub");
}

async function assertIngestCannotWriteInto(target, attacker) {
	const eventsBefore = eventIds(target.dbPath);
	const countBefore = countEvents(target.dbPath);
	const stealWorkflow = await call("/ingest", {
		method: "POST",
		headers: attacker.hub.headers,
		body: JSON.stringify({
			instance_id: attacker.hub.deviceId,
			version: "1",
			events: [
				{
					id: `steal-${target.org.slug}-${Date.now()}`,
					kind: "step.started",
					workflow_id: target.workflowId,
					created_at: "2026-06-01T12:01:00.000Z",
					data: { step_id: "nope" },
				},
			],
		}),
	});
	assert.ok(stealWorkflow.status === 200 || stealWorkflow.status === 403, dump(stealWorkflow.body));
	assert.deepEqual(eventIds(target.dbPath), eventsBefore);
	assert.equal(countEvents(target.dbPath), countBefore);

	const stealInstance = await call("/ingest", {
		method: "POST",
		headers: attacker.hub.headers,
		body: JSON.stringify({
			instance_id: target.hub.deviceId,
			version: "1",
			events: [{ id: `impersonate-${target.org.slug}`, kind: "heartbeat", data: {} }],
		}),
	});
	assert.equal(stealInstance.status, 403);
	assert.deepEqual(eventIds(target.dbPath), eventsBefore);
	assert.equal(countEvents(target.dbPath), countBefore);
}

test("org A cannot read, list, modify or enumerate org B", async () => {
	await assertIsolation(orgA, orgB);
});

test("org B cannot read, list, modify or enumerate org A", async () => {
	await assertIsolation(orgB, orgA);
});

test("ingest from B using A's workflow_id or instance_id does not write into A", async () => {
	await assertIngestCannotWriteInto(orgA, orgB);
});

test("ingest from A using B's workflow_id or instance_id does not write into B", async () => {
	await assertIngestCannotWriteInto(orgB, orgA);
});

test("JWT with a tampered or mismatched org claim is rejected", async () => {
	const me = await call("/api/auth/me", { headers: { cookie: orgA.admin.cookie } });
	assert.equal(me.status, 200);
	assert.equal(me.body.user.email, orgA.admin.email);

	const raw = cookieJwt(orgA.admin.cookie);
	const parts = raw.split(".");
	const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	assert.equal(payload.org, orgA.org.id);

	const unsigned = Buffer.from(JSON.stringify({ ...payload, org: orgB.org.id })).toString("base64url");
	const tampered = `${parts[0]}.${unsigned}.${parts[2]}`;
	const unsignedRes = await call("/api/auth/me", { headers: { cookie: `target_auth=${tampered}` } });
	assert.equal(unsignedRes.status, 401);

	const mismatched = signJwt({ ...payload, org: orgB.org.id }, db.getJwtSecret());
	const mismatchedRes = await call("/api/auth/me", { headers: { cookie: `target_auth=${mismatched}` } });
	assert.equal(mismatchedRes.status, 401);
});
