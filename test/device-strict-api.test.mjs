import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-device-strict-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.TARGET_DEVICE_LINKING_MODE = "required";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
const { hashToken } = await import("../auth.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const owner = db.getAuthUserByEmail("admin@admin.com");
db.createDeviceLinkRequest({
	id: "strict-request", deviceName: "Strict hub", publicKey: "ed25519-strict", scopes: ["ingest:write", "sync:write"],
	pollingCredentialHash: hashToken("strict-poll"), expiresAt: "2027-01-01T00:00:00.000Z",
});
db.decideDeviceLinkRequest({ requestId: "strict-request", ownerUserId: owner.id, decision: "approved", decidedAt: "2026-01-01T00:00:00.000Z" });
const device = db.consumeDeviceLinkRequest({
	requestId: "strict-request", pollingCredentialHash: hashToken("strict-poll"), deviceId: "dev-strict",
	deviceSecretHash: hashToken("strict-secret"), consumedAt: "2026-01-01T00:00:01.000Z",
});
const headers = { authorization: "Target-Device v1 dev-strict.strict-secret", "content-type": "application/json" };

function signedDisconnectHeaders(deviceId, secret, privateKey) {
	const date = new Date().toISOString();
	const nonce = `nonce_${createHash("sha256").update(`${deviceId}:${date}:${Math.random()}`).digest("base64url").slice(0, 32)}`;
	const hash = createHash("sha256").update("{}").digest("hex");
	const canonical = `target-device-v1\nPOST\n/api/device-links/devices/self/disconnect\n${hash}\n${date}\n${nonce}\n${deviceId}`;
	return {
		authorization: `Target-Device v1 ${deviceId}.${secret}`,
		"content-type": "application/json",
		"x-target-date": date,
		"x-target-nonce": nonce,
		"x-target-signature": sign(null, Buffer.from(canonical), privateKey).toString("base64url"),
	};
}

test("strict mode rejects anonymous report and sync before state creation", async () => {
	const anonymousReport = await fetch(`${base}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instance_id: "attacker", events: [] }) });
	assert.equal(anonymousReport.status, 401);
	assert.equal(db.listInstances().length, 0);
	const anonymousRegister = await fetch(`${base}/api/sync/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "attacker" }) });
	assert.equal(anonymousRegister.status, 401);
	assert.equal(db.listClients().length, 0);
});

test("strict device identity owns only its report/sync client and cannot use operator APIs", async () => {
	const mismatch = await fetch(`${base}/ingest`, { method: "POST", headers, body: JSON.stringify({ instance_id: "other-device", events: [] }) });
	assert.equal(mismatch.status, 403);
	const report = await fetch(`${base}/ingest`, {
		method: "POST", headers,
		body: JSON.stringify({ instance_id: device.id, version: "1", events: [{ id: "strict-event", kind: "heartbeat", data: {} }] }),
	});
	assert.equal(report.status, 200);
	assert.equal(db.listInstances()[0].instanceId, device.id);
	const register = await fetch(`${base}/api/sync/register`, {
		method: "POST", headers,
		body: JSON.stringify({ name: "payload name", capabilities: { commands: [] } }),
	});
	assert.equal(register.status, 201);
	assert.equal((await register.json()).client_token, undefined);
	const heartbeat = await fetch(`${base}/api/sync/heartbeat`, { method: "POST", headers, body: JSON.stringify({ status: "idle" }) });
	assert.equal(heartbeat.status, 200);
	const event = await fetch(`${base}/api/sync/events`, {
		method: "POST", headers,
		body: JSON.stringify({ events: [{ id: "strict-sync-event", type: "client.heartbeat", payload: { status: "idle" } }] }),
	});
	assert.equal(event.status, 200);
	assert.equal(db.open().prepare("SELECT device_id, owner_user_id FROM sync_events WHERE id = ?").get("strict-sync-event").device_id, device.id);
	const operator = await fetch(`${base}/api/sync/clients`, { headers: { authorization: headers.authorization } });
	assert.equal(operator.status, 401);
	// `401` is the remote revocation signal the hub maps to relink-required.
	// It must never imply deletion: its local workflows/resources are outside
	// this server, and even the server's historical mirrors remain intact.
	const instancesBeforeRevoke = db.listInstances().length;
	const clientsBeforeRevoke = db.listClients().length;
	const syncEventBeforeRevoke = db.open().prepare("SELECT COUNT(*) AS n FROM sync_events WHERE device_id = ?").get(device.id).n;
	db.revokeLinkedDevice({ deviceId: device.id, actorUserId: owner.id, revokedAt: "2026-01-01T00:01:00.000Z" });
	const revoked = await fetch(`${base}/ingest`, { method: "POST", headers, body: JSON.stringify({ instance_id: device.id, events: [] }) });
	assert.equal(revoked.status, 401);
	assert.equal(db.listInstances().length, instancesBeforeRevoke);
	assert.equal(db.listClients().length, clientsBeforeRevoke);
	assert.equal(db.open().prepare("SELECT COUNT(*) AS n FROM sync_events WHERE device_id = ?").get(device.id).n, syncEventBeforeRevoke);
});

test("expired device credentials are rejected before ingest or sync creates state", async () => {
	db.createDeviceLinkRequest({
		id: "expired-device-request", deviceName: "Expired strict hub", publicKey: "ed25519-expired-device",
		scopes: ["ingest:write", "sync:write"], pollingCredentialHash: hashToken("expired-device-poll"),
		expiresAt: "2027-01-01T00:00:00.000Z",
	});
	db.decideDeviceLinkRequest({ requestId: "expired-device-request", ownerUserId: owner.id, decision: "approved", decidedAt: "2026-01-01T00:00:00.000Z" });
	const expiredDevice = db.consumeDeviceLinkRequest({
		requestId: "expired-device-request", pollingCredentialHash: hashToken("expired-device-poll"),
		deviceId: "dev-expired", deviceSecretHash: hashToken("expired-device-secret"),
		consumedAt: "2026-01-01T00:00:01.000Z", credentialExpiresAt: "2020-01-01T00:00:00.000Z",
	});
	const expiredHeaders = { authorization: "Target-Device v1 dev-expired.expired-device-secret", "content-type": "application/json" };
	const instancesBefore = db.listInstances().length;
	const clientsBefore = db.listClients().length;
	const report = await fetch(`${base}/ingest`, { method: "POST", headers: expiredHeaders, body: JSON.stringify({ instance_id: expiredDevice.id, events: [] }) });
	assert.equal(report.status, 401);
	const sync = await fetch(`${base}/api/sync/register`, { method: "POST", headers: expiredHeaders, body: JSON.stringify({ name: "expired" }) });
	assert.equal(sync.status, 401);
	assert.equal(db.listInstances().length, instancesBefore);
	assert.equal(db.listClients().length, clientsBefore);
});

test("a device can disconnect only itself, idempotently, while history is retained", async () => {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
	db.createDeviceLinkRequest({ id: "disconnect-request", deviceName: "Disconnect hub", publicKey: rawPublicKey, scopes: ["sync:write"], pollingCredentialHash: hashToken("disconnect-poll"), expiresAt: "2027-01-01T00:00:00.000Z" });
	db.decideDeviceLinkRequest({ requestId: "disconnect-request", ownerUserId: owner.id, decision: "approved", decidedAt: "2026-01-01T00:00:00.000Z" });
	const disconnecting = db.consumeDeviceLinkRequest({ requestId: "disconnect-request", pollingCredentialHash: hashToken("disconnect-poll"), deviceId: "dev-disconnect", deviceSecretHash: hashToken("disconnect-secret"), consumedAt: "2026-01-01T00:00:01.000Z" });
	db.upsertClient({ id: disconnecting.id, name: "disconnect", tokenHash: "device:dev-disconnect", deviceId: disconnecting.id, ownerUserId: owner.id });
	db.createDeviceLinkRequest({ id: "companion-request", deviceName: "Active companion", publicKey: rawPublicKey, scopes: ["sync:write"], pollingCredentialHash: hashToken("companion-poll"), expiresAt: "2027-01-01T00:00:00.000Z" });
	db.decideDeviceLinkRequest({ requestId: "companion-request", ownerUserId: owner.id, decision: "approved", decidedAt: "2026-01-01T00:00:00.000Z" });
	const companion = db.consumeDeviceLinkRequest({ requestId: "companion-request", pollingCredentialHash: hashToken("companion-poll"), deviceId: "dev-companion", deviceSecretHash: hashToken("companion-secret"), consumedAt: "2026-01-01T00:00:01.000Z" });
	db.rotateDeviceCredential({ deviceId: companion.id, currentSecretHash: hashToken("companion-secret"), newSecretHash: hashToken("companion-secret-v2") });
	const supersededProof = signedDisconnectHeaders("dev-companion", "companion-secret", privateKey);
	assert.equal((await fetch(`${base}/api/device-links/devices/self/disconnect`, { method: "POST", headers: supersededProof, body: "{}" })).status, 401);
	const headers = signedDisconnectHeaders("dev-disconnect", "disconnect-secret", privateKey);
	const noCredential = await fetch(`${base}/api/device-links/devices/self/disconnect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert.equal(noCredential.status, 401);
	const invalidSignature = { ...signedDisconnectHeaders("dev-disconnect", "disconnect-secret", privateKey), "x-target-signature": "invalid" };
	assert.equal((await fetch(`${base}/api/device-links/devices/self/disconnect`, { method: "POST", headers: invalidSignature, body: "{}" })).status, 401);
	const invalidSecret = signedDisconnectHeaders("dev-disconnect", "wrong-secret", privateKey);
	assert.equal((await fetch(`${base}/api/device-links/devices/self/disconnect`, { method: "POST", headers: invalidSecret, body: "{}" })).status, 401);
	assert.equal((await fetch(`${base}/api/device-links/devices/self/disconnect`, { method: "POST", headers, body: JSON.stringify({ device_id: companion.id }) })).status, 422);
	const response = await fetch(`${base}/api/device-links/devices/self/disconnect`, { method: "POST", headers, body: "{}" });
	assert.equal(response.status, 200);
	assert.equal((await response.json()).idempotent, false);
	const again = await fetch(`${base}/api/device-links/devices/self/disconnect`, { method: "POST", headers: signedDisconnectHeaders("dev-disconnect", "disconnect-secret", privateKey), body: "{}" });
	assert.equal(again.status, 200);
	assert.equal((await again.json()).idempotent, true);
	assert.equal(db.listLinkedDevices().some((d) => d.id === disconnecting.id), false);
	assert.equal(db.listLinkedDevices({ includeArchived: true }).some((d) => d.id === disconnecting.id), true);
	assert.equal(db.listClients().find((c) => c.id === disconnecting.id).status, "archived");
	assert.ok(db.listDeviceAudit({ deviceId: disconnecting.id }).some((e) => e.action === "device.disconnected"));
	const forged = await fetch(`${base}/api/device-links/devices/self/disconnect`, { method: "POST", headers: { authorization: "Target-Device v1 dev-strict.disconnect-secret", "content-type": "application/json" }, body: "{}" });
	assert.equal(forged.status, 401);
	const replayNonce = await fetch(`${base}/api/device-links/devices/self/disconnect`, { method: "POST", headers, body: "{}" });
	assert.equal(replayNonce.status, 401);
	const noIngest = await fetch(`${base}/ingest`, { method: "POST", headers: { authorization: "Target-Device v1 dev-disconnect.disconnect-secret", "content-type": "application/json" }, body: JSON.stringify({ instance_id: disconnecting.id, events: [] }) });
	assert.equal(noIngest.status, 401);
	const noRegister = await fetch(`${base}/api/sync/register`, { method: "POST", headers: { authorization: "Target-Device v1 dev-disconnect.disconnect-secret", "content-type": "application/json" }, body: JSON.stringify({ name: "again" }) });
	assert.equal(noRegister.status, 401);
	const noPoll = await fetch(`${base}/api/sync/commands`, { headers: { authorization: "Target-Device v1 dev-disconnect.disconnect-secret" } });
	assert.equal(noPoll.status, 401);
	const companionRegister = await fetch(`${base}/api/sync/register`, { method: "POST", headers: { authorization: "Target-Device v1 dev-companion.companion-secret-v2", "content-type": "application/json" }, body: JSON.stringify({ name: "still active" }) });
	assert.equal(companionRegister.status, 201);
	assert.equal(db.listLinkedDevices().some((d) => d.id === companion.id), true);
});
