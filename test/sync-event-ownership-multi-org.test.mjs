/**
 * With TARGET_MULTI_ORG=1 a hub in org B cannot touch org A's remote workflow
 * through POST /api/sync/events, and two hubs inside one org are still held to
 * the per-client ownership check.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { outboxDir } from "../mailer.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-event-ownership-mo-"));
process.env.TARGET_SERVER_DB = path.join(tmpDir, "default.db");
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");
process.env.TARGET_MULTI_ORG = "1";
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_PUBLIC_URL = "http://127.0.0.1:8900";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
process.env.TARGET_SUPERUSER_EMAIL = "seo-su@example.com";

const { server } = await import("../server.mjs");
const control = await import("../control-plane.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

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

async function setupCookie(email, password) {
	const token = setupTokenFromMail(email);
	assert.ok(token, `setup token missing for ${email}`);
	const res = await fetch(`${base}/api/auth/setup`, json("POST", { token, password }));
	assert.equal(res.status, 200, await res.clone().text());
	return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

function ed25519PublicValue() {
	const { publicKey } = generateKeyPairSync("ed25519");
	return publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
}

/** Pair a hub with the org of `cookie` and register it as a sync client. */
async function linkedHub(cookie, name) {
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
		body: JSON.stringify({ name, capabilities: { commands: ["workflow.create"], runners: [{ id: "claude", installed: true }] } }),
	});
	assert.equal(register.status, 201, JSON.stringify(register.body));
	return { id: register.body.client_id, headers };
}

async function provisionOrg(suCookie, { name, slug, adminEmail, password }) {
	const created = await call("/api/platform/orgs", json("POST", { name, slug, admin_email: adminEmail }, suCookie));
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const cookie = await setupCookie(adminEmail, password);
	const hub = await linkedHub(cookie, `${slug} hub`);
	const remote = await call(
		"/api/sync/remote-workflows",
		json("POST", { client_id: hub.id, name: `${slug} remote`, agent: "claude" }, cookie),
	);
	assert.equal(remote.status, 201, JSON.stringify(remote.body));
	return {
		cookie,
		hub,
		dbPath: control.getOrganization(created.body.org.id).dbPath,
		remoteId: remote.body.remote_workflow.id,
	};
}

function readRows(dbPath, remoteId) {
	const handle = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return {
			workflow: handle.prepare("SELECT * FROM remote_workflows WHERE id = ?").get(remoteId),
			eventIds: handle.prepare("SELECT id FROM sync_events ORDER BY id").all().map((row) => row.id),
		};
	} finally {
		handle.close();
	}
}

async function postEvents(hub, events) {
	const res = await call("/api/sync/events", { method: "POST", headers: hub.headers, body: JSON.stringify({ events }) });
	assert.equal(res.status, 200, JSON.stringify(res.body));
	return res.body;
}

const suToken = setupTokenFromMail("seo-su@example.com");
assert.ok(suToken, "superuser setup token missing");
const suRes = await fetch(`${base}/api/auth/setup`, json("POST", { token: suToken, password: "super-password-12" }));
assert.equal(suRes.status, 200);
const suCookie = (suRes.headers.get("set-cookie") ?? "").split(";")[0];

const orgA = await provisionOrg(suCookie, {
	name: "Sync Owner Alpha",
	slug: "seo-alpha",
	adminEmail: "admin-a@seo.example.com",
	password: "alpha-admin-pass-12",
});
const orgB = await provisionOrg(suCookie, {
	name: "Sync Owner Beta",
	slug: "seo-beta",
	adminEmail: "admin-b@seo.example.com",
	password: "beta-admin-pass-12",
});

test("hub in org B cannot write events into or mirror onto org A's remote workflow", async () => {
	const before = readRows(orgA.dbPath, orgA.remoteId);
	assert.ok(before.workflow);

	// Org A's row lives in org A's DB file, so from org B's request context the
	// id is simply unknown: it is accepted into B's own log with nothing to mirror.
	const result = await postEvents(orgB.hub, [
		{ id: "cross-org-status", type: "workflow.status_changed", remote_id: orgA.remoteId, payload: { to: "failed" } },
	]);
	assert.deepEqual(result, { accepted: ["cross-org-status"], rejected: [], duplicates: [] });

	assert.deepEqual(readRows(orgA.dbPath, orgA.remoteId), before);
	assert.equal(readRows(orgB.dbPath, orgA.remoteId).workflow, undefined);
});

test("second hub in the same org is rejected for the first hub's remote workflow", async () => {
	const intruder = await linkedHub(orgA.cookie, "seo-alpha second hub");
	const before = readRows(orgA.dbPath, orgA.remoteId);
	const result = await postEvents(intruder, [
		{ id: "same-org-steal", type: "workflow.status_changed", remote_id: orgA.remoteId, payload: { to: "failed" } },
	]);
	assert.deepEqual(result, { accepted: [], rejected: [{ id: "same-org-steal", reason: "foreign_remote_id" }], duplicates: [] });
	assert.deepEqual(readRows(orgA.dbPath, orgA.remoteId), before);

	const own = await postEvents(orgA.hub, [
		{ id: "same-org-own", type: "workflow.status_changed", remote_id: orgA.remoteId, payload: { to: "running" } },
	]);
	assert.deepEqual(own.accepted, ["same-org-own"]);
	assert.equal(readRows(orgA.dbPath, orgA.remoteId).workflow.status, "running");
});
