import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { once } from "node:events";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-device-link-api-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.TARGET_DEVICE_LINKING_MODE = "optional";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";

const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
const { hashPassword } = await import("../auth.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

async function login(email = "admin@admin.com", password = "password-target-server") {
	const res = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	assert.equal(res.status, 200);
	return res.headers.get("set-cookie").split(";")[0];
}

async function request(pathname, options = {}) {
	return fetch(`${base}${pathname}`, options);
}

function createPayload(name = "Ada hub") {
	return {
		contract_version: "device-link/v1",
		device_name: name,
		hub_version: "0.9.0",
		public_key: { algorithm: "ed25519", value: "a".repeat(43) },
		requested_scopes: ["ingest:write", "sync:write"],
	};
}

let adminCookie;
let linkerCookie;
before(async () => {
	adminCookie = await login();
	const role = db.createRole({ name: "Viewer", permissions: ["activity.read"] });
	const user = db.createAuthUser({ email: "viewer@example.com", roleId: role.id });
	db.setUserPassword(user.id, await hashPassword("viewer-password-123"));
	const linkerRole = db.createRole({ name: "Device linker", permissions: ["devices.link"] });
	const linker = db.createAuthUser({ email: "linker@example.com", roleId: linkerRole.id });
	db.setUserPassword(linker.id, await hashPassword("linker-password-123"));
	linkerCookie = await login("linker@example.com", "linker-password-123");
});

test("a saved devices.link role can approve but cannot manage devices", async () => {
	const created = await request("/api/device-links/requests", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(createPayload("Linker hub")),
	});
	const link = await created.json();
	const approved = await request(`/api/device-links/requests/${link.request_id}/approve`, {
		method: "POST",
		headers: { cookie: linkerCookie, "content-type": "application/json" },
		body: "{}",
	});
	assert.equal(approved.status, 200);
	assert.equal((await approved.json()).state, "approved");
	assert.equal((await request("/api/device-links/devices", { headers: { cookie: linkerCookie } })).status, 403);
});
after(() => server.close());

test("device link requires a human session and permission for approval", async () => {
	const created = await request("/api/device-links/requests", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(createPayload()),
	});
	assert.equal(created.status, 201);
	const link = await created.json();
	assert.match(link.browser_url, /\/link\/device\/dlr_/);
	assert.equal(link.browser_url.includes(link.polling_credential), false);

	const unauthenticated = await request(`/api/device-links/requests/${link.request_id}/approve`, { method: "POST" });
	assert.equal(unauthenticated.status, 401);

	const viewerCookie = await login("viewer@example.com", "viewer-password-123");
	const forbidden = await request(`/api/device-links/requests/${link.request_id}/approve`, {
		method: "POST",
		headers: { cookie: viewerCookie },
	});
	assert.equal(forbidden.status, 403);

	// Payload ownership is ignored: the current authorized human becomes owner.
	const approved = await request(`/api/device-links/requests/${link.request_id}/approve`, {
		method: "POST",
		headers: { cookie: adminCookie, "content-type": "application/json" },
		body: JSON.stringify({ owner_user_id: "viewer" }),
	});
	assert.equal(approved.status, 200);
	assert.equal((await approved.json()).state, "approved");

	const wrongCredential = await request(`/api/device-links/requests/${link.request_id}/poll`, {
		method: "POST",
		headers: { authorization: "Target-Link forged" },
	});
	assert.equal(wrongCredential.status, 401);

	const polled = await request(`/api/device-links/requests/${link.request_id}/poll`, {
		method: "POST",
		headers: { authorization: `Target-Link ${link.polling_credential}` },
	});
	assert.equal(polled.status, 200);
	assert.equal((await polled.json()).state, "approved");

	const consumed = await request(`/api/device-links/requests/${link.request_id}/consume`, {
		method: "POST",
		headers: { authorization: `Target-Link ${link.polling_credential}`, "content-type": "application/json" },
		body: "{}",
	});
	assert.equal(consumed.status, 201);
	const activated = await consumed.json();
	assert.ok(activated.device.id.startsWith("dev_"));
	assert.ok(activated.device_secret);
	assert.equal(activated.owner, undefined);
	assert.equal(JSON.stringify(activated).includes("permissions"), false);

	const replay = await request(`/api/device-links/requests/${link.request_id}/consume`, {
		method: "POST",
		headers: { authorization: `Target-Link ${link.polling_credential}` },
	});
	assert.equal(replay.status, 409);

	const devices = await request("/api/device-links/devices", { headers: { cookie: adminCookie } });
	assert.equal(devices.status, 200);
	const device = (await devices.json()).devices.find((row) => row.id === activated.device.id);
	assert.equal(device.ownerUserId, db.getAuthUserByEmail("admin@admin.com").id);
	assert.equal(JSON.stringify(device).includes(activated.device_secret), false);
});

test("device-list and revocation enforce RBAC and revoked credentials stop working", async () => {
	const viewerCookie = await login("viewer@example.com", "viewer-password-123");
	const forbidden = await request("/api/device-links/devices", { headers: { cookie: viewerCookie } });
	assert.equal(forbidden.status, 403);

	const devices = await (await request("/api/device-links/devices", { headers: { cookie: adminCookie } })).json();
	const device = devices.devices[0];
	const revoked = await request(`/api/device-links/devices/${device.id}/revoke`, {
		method: "POST",
		headers: { cookie: adminCookie, "content-type": "application/json" },
		body: JSON.stringify({ reason: "test revoke" }),
	});
	assert.equal(revoked.status, 200);
	assert.equal((await revoked.json()).device.status, "revoked");
	const auditForbidden = await request(`/api/device-links/devices/${device.id}/audit`, { headers: { cookie: viewerCookie } });
	assert.equal(auditForbidden.status, 403);
	const history = await (await request("/api/device-links/devices?history=1", { headers: { cookie: adminCookie } })).json();
	assert.equal(history.devices.some((row) => row.id === device.id && row.status === "revoked"), true);
	const audit = await (await request(`/api/device-links/devices/${device.id}/audit`, { headers: { cookie: adminCookie } })).json();
	assert.equal(audit.device.status, "revoked");
	assert.equal(audit.audit.some((entry) => entry.action === "device.revoked"), true);
	assert.equal(JSON.stringify(audit).includes("credential"), false);
});

test("optional mode preserves legacy sync registration during migration", async () => {
	const legacy = await request("/api/sync/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "Legacy client" }),
	});
	assert.equal(legacy.status, 201);
	const body = await legacy.json();
	assert.ok(body.client_token.startsWith("sync_"));
	assert.equal(body.owner, null);
});

test("expired pairing credentials are rejected without exposing request state", async () => {
	const requestId = "expired-http-request";
	db.createDeviceLinkRequest({
		id: requestId,
		deviceName: "Expired hub",
		publicKey: "ed25519-expired",
		scopes: ["ingest:write"],
		pollingCredentialHash: (await import("../auth.mjs")).hashToken("expired-http-secret"),
		expiresAt: "2020-01-01T00:00:00.000Z",
	});
	const response = await request(`/api/device-links/requests/${requestId}/poll`, {
		method: "POST",
		headers: { authorization: "Target-Link expired-http-secret" },
	});
	assert.equal(response.status, 401);
	assert.deepEqual(await response.json(), { error: "invalid_link_credential" });
});

test("link initiation rate limit rejects excess requests without issuing credentials", async () => {
	let limited = null;
	for (let i = 0; i < 12; i++) {
		const response = await request("/api/device-links/requests", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(createPayload(`rate-${i}`)),
		});
		if (response.status === 429) {
			limited = response;
			break;
		}
	}
	assert.ok(limited);
	assert.equal((await limited.json()).error, "too_many_requests");
	assert.ok(limited.headers.get("retry-after"));
});
