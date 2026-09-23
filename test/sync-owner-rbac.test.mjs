import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-owner-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.TARGET_DEVICE_LINKING_MODE = "optional";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
const { hashToken } = await import("../auth.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

function assertOwnerShape(owner, expectedPermissions) {
	assert.ok(owner);
	assert.ok(typeof owner.id === "string" && owner.id.length > 0);
	assert.deepEqual(owner.permissions, expectedPermissions);
	assert.equal(owner.email, undefined);
	assert.equal(owner.token_version, undefined);
	assert.equal(owner.tokenVersion, undefined);
	for (const scope of db.DEVICE_SCOPES) {
		assert.equal(owner.permissions.includes(scope), false);
	}
	const catalog = db.getPermissionCatalog();
	assert.deepEqual(owner.catalog, catalog);
	const grantedIds = owner.granted.groups.flatMap((group) => group.permissions.map((permission) => permission.id)).sort();
	assert.deepEqual(grantedIds, [...expectedPermissions].sort());
	assert.ok(owner.catalog.groups.some((group) => group.permissions.some((permission) => !expectedPermissions.includes(permission.id))));
	assert.equal(JSON.stringify(owner).includes("ingest:write"), false);
	assert.equal(JSON.stringify(owner).includes("sync:write"), false);
}

function linkDevice({ requestId, ownerUserId, secret }) {
	db.createDeviceLinkRequest({
		id: requestId,
		deviceName: "Owner hub",
		publicKey: `ed25519-${requestId}`,
		scopes: ["ingest:write", "sync:write"],
		pollingCredentialHash: hashToken(`${requestId}-poll`),
		expiresAt: "2027-01-01T00:00:00.000Z",
	});
	db.decideDeviceLinkRequest({
		requestId,
		ownerUserId,
		decision: "approved",
		decidedAt: "2026-01-01T00:00:00.000Z",
	});
	return db.consumeDeviceLinkRequest({
		requestId,
		pollingCredentialHash: hashToken(`${requestId}-poll`),
		deviceId: `dev-${requestId}`,
		deviceSecretHash: hashToken(secret),
		consumedAt: "2026-01-01T00:00:01.000Z",
	});
}

test("legacy register and heartbeat send owner null and do not invent a user", async () => {
	const register = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "Legacy owner-check" }),
	});
	assert.equal(register.status, 201);
	const registered = await register.json();
	assert.equal(registered.owner, null);
	assert.ok(registered.client_token.startsWith("sync_"));
	const heartbeat = await fetch(`${base}/api/sync/heartbeat`, {
		method: "POST",
		headers: { authorization: `Bearer ${registered.client_token}`, "content-type": "application/json" },
		body: JSON.stringify({ status: "idle" }),
	});
	assert.equal(heartbeat.status, 200);
	const body = await heartbeat.json();
	assert.equal(body.ok, true);
	assert.equal(body.owner, null);
});

test("linked register and heartbeat expose the owner's current role and refresh after a role change", async () => {
	const admin = await login(base);
	const role = (
		await (
			await fetch(`${base}/api/auth/roles`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie: admin },
				body: JSON.stringify({ name: "Hub viewer", permissions: ["client.read", "client.workflows.create"] }),
			})
		).json()
	).role;
	const invited = await (
		await fetch(`${base}/api/auth/users`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: admin },
			body: JSON.stringify({ email: "hub-owner@example.com", role_id: role.id }),
		})
	).json();
	const token = new URL(invited.invite.setupUrl).searchParams.get("token");
	const setup = await fetch(`${base}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, password: "hub-owner-pass-12" }),
	});
	assert.equal(setup.status, 200);
	const owner = (await setup.json()).user;
	assert.deepEqual(owner.permissions, ["client.read", "client.workflows.create"]);

	const device = linkDevice({ requestId: "owner-rbac", ownerUserId: owner.id, secret: "owner-secret" });
	const headers = { authorization: "Target-Device v1 dev-owner-rbac.owner-secret", "content-type": "application/json" };
	const register = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name: "payload name" }),
	});
	assert.equal(register.status, 201);
	const registered = await register.json();
	assert.equal(registered.client_token, undefined);
	assertOwnerShape(registered.owner, ["client.read", "client.workflows.create"]);
	assert.equal(registered.owner.id, owner.id);

	const firstBeat = await fetch(`${base}/api/sync/heartbeat`, {
		method: "POST",
		headers,
		body: JSON.stringify({ status: "idle" }),
	});
	assert.equal(firstBeat.status, 200);
	assertOwnerShape((await firstBeat.json()).owner, ["client.read", "client.workflows.create"]);

	const changed = await fetch(`${base}/api/auth/roles/${role.id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json", cookie: admin },
		body: JSON.stringify({ name: "Hub viewer", permissions: ["activity.read", "client.read"] }),
	});
	assert.equal(changed.status, 200);

	const refreshed = await fetch(`${base}/api/sync/heartbeat`, {
		method: "POST",
		headers,
		body: JSON.stringify({ status: "busy" }),
	});
	assert.equal(refreshed.status, 200);
	const after = await refreshed.json();
	assertOwnerShape(after.owner, ["activity.read", "client.read"]);
	assert.equal(after.owner.id, owner.id);
	assert.equal(device.scopes.includes("sync:write"), true);
});
