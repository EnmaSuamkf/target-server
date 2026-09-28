/**
 * Ingest owner guards: a linked hub must not mix events into another
 * account's workflow_id, and a token/open emitter must not impersonate a
 * linked hub's instance_id.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { once } from "node:events";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-ingest-owner-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.TARGET_DEVICE_LINKING_MODE = "optional";
process.env.TARGET_INGEST_TOKEN = "ingest-owner-guard-token";
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

const INGEST_TOKEN = process.env.TARGET_INGEST_TOKEN;
const NOW = "2026-06-01T12:00:00.000Z";
const SECRET_A = "secret-a";
const SECRET_B = "secret-b";

let userA;
let userB;
let deviceA;
let deviceB;

function linkHub({ requestId, ownerUserId, deviceId, secret }) {
	db.createDeviceLinkRequest({
		id: requestId,
		deviceName: `${requestId} hub`,
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
		deviceId,
		deviceSecretHash: hashToken(secret),
		consumedAt: "2026-01-01T00:00:01.000Z",
	});
}

function deviceHeaders(deviceId, secret) {
	return { authorization: `Target-Device v1 ${deviceId}.${secret}`, "content-type": "application/json" };
}

function tokenHeaders() {
	return { authorization: `Bearer ${INGEST_TOKEN}`, "content-type": "application/json" };
}

function event(id, kind, workflowId, data = {}) {
	const row = { id, kind, created_at: NOW, data };
	if (workflowId !== undefined) row.workflow_id = workflowId;
	return row;
}

function envelope(instanceId, events, extra = {}) {
	return {
		batch_id: extra.batch_id ?? `b-${instanceId}`,
		instance_id: instanceId,
		version: extra.version ?? "0.2.0",
		schema_version: 1,
		sent_at: NOW,
		user: extra.user ?? { display_name: "Hub" },
		events,
	};
}

async function ingest(headers, instanceId, events, extra = {}) {
	const res = await fetch(`${base}/ingest`, {
		method: "POST",
		headers,
		body: JSON.stringify(envelope(instanceId, events, extra)),
	});
	return { status: res.status, body: await res.json() };
}

function eventRow(id) {
	return db.open().prepare("SELECT id, owner_user_id, workflow_id FROM events WHERE id = ?").get(id);
}

function instanceRow(instanceId) {
	return db.open().prepare("SELECT instance_id, owner_user_id, device_id, last_seen_at, events_count FROM instances WHERE instance_id = ?").get(instanceId);
}

before(() => {
	userA = db.createAuthUser({ email: "owner-a@example.com" });
	userB = db.createAuthUser({ email: "owner-b@example.com" });
	deviceA = linkHub({ requestId: "req-a", ownerUserId: userA.id, deviceId: "dev-owner-a", secret: SECRET_A });
	deviceB = linkHub({ requestId: "req-b", ownerUserId: userB.id, deviceId: "dev-owner-b", secret: SECRET_B });
});

test("linked hub A creates a workflow and later events are accepted", async () => {
	const headers = deviceHeaders(deviceA.id, SECRET_A);
	const created = await ingest(headers, deviceA.id, [
		event("a-created", "workflow.created", "wf-a", { name: "Alpha" }),
	]);
	assert.equal(created.status, 200);
	assert.deepEqual(created.body.accepted, ["a-created"]);
	assert.equal(created.body.rejected.length, 0);
	assert.equal(eventRow("a-created").owner_user_id, userA.id);

	const follow = await ingest(headers, deviceA.id, [
		event("a-step", "step.started", "wf-a", { step_id: "s1" }),
	]);
	assert.equal(follow.status, 200);
	assert.deepEqual(follow.body.accepted, ["a-step"]);
	assert.equal(follow.body.rejected.length, 0);
	assert.equal(eventRow("a-step").owner_user_id, userA.id);
	assert.deepEqual(db.workflowOwner("wf-a"), { exists: true, ownerUserId: userA.id });
});

test("linked hub B cannot insert events under A's workflow_id", async () => {
	const headersA = deviceHeaders(deviceA.id, SECRET_A);
	const seed = await ingest(headersA, deviceA.id, [event("a-owned", "workflow.created", "wf-a-steal", { name: "A owned" })]);
	assert.equal(seed.status, 200);

	const steal = await ingest(deviceHeaders(deviceB.id, SECRET_B), deviceB.id, [
		event("b-steal", "step.started", "wf-a-steal", { step_id: "nope" }),
	]);
	assert.equal(steal.status, 200);
	assert.deepEqual(steal.body.accepted, []);
	assert.equal(steal.body.rejected.length, 1);
	assert.equal(steal.body.rejected[0].id, "b-steal");
	assert.equal(steal.body.rejected[0].reason, "workflow_owner_mismatch");
	assert.equal(eventRow("b-steal"), undefined);
	assert.deepEqual(db.workflowOwner("wf-a-steal"), { exists: true, ownerUserId: userA.id });
});

test("token ingest cannot insert events under a linked hub's workflow_id", async () => {
	const seed = await ingest(deviceHeaders(deviceA.id, SECRET_A), deviceA.id, [
		event("a-token-guard", "workflow.created", "wf-a-token", { name: "A vs token" }),
	]);
	assert.equal(seed.status, 200);

	const res = await ingest(tokenHeaders(), "inst-token-thief", [
		event("tok-steal", "step.started", "wf-a-token", { step_id: "nope" }),
	]);
	assert.equal(res.status, 200);
	assert.deepEqual(res.body.accepted, []);
	assert.equal(res.body.rejected.length, 1);
	assert.equal(res.body.rejected[0].id, "tok-steal");
	assert.equal(res.body.rejected[0].reason, "workflow_owner_mismatch");
	assert.equal(eventRow("tok-steal"), undefined);
	assert.equal(instanceRow("inst-token-thief").owner_user_id, null);
});

test("a token-created workflow can be claimed by hub A", async () => {
	const created = await ingest(tokenHeaders(), "inst-token-null", [
		event("tok-created", "workflow.created", "wf-null", { name: "Orphan" }),
	]);
	assert.equal(created.status, 200);
	assert.deepEqual(created.body.accepted, ["tok-created"]);
	assert.equal(eventRow("tok-created").owner_user_id, null);
	assert.deepEqual(db.workflowOwner("wf-null"), { exists: true, ownerUserId: null });

	const claim = await ingest(deviceHeaders(deviceA.id, SECRET_A), deviceA.id, [
		event("a-claim", "step.started", "wf-null", { step_id: "s1" }),
	]);
	assert.equal(claim.status, 200);
	assert.deepEqual(claim.body.accepted, ["a-claim"]);
	assert.equal(claim.body.rejected.length, 0);
	assert.equal(eventRow("a-claim").owner_user_id, userA.id);
	assert.deepEqual(db.workflowOwner("wf-null"), { exists: true, ownerUserId: null });
});

test("re-posting a stored event is accepted as a duplicate", async () => {
	const headersA = deviceHeaders(deviceA.id, SECRET_A);
	const original = event("a-dup", "workflow.created", "wf-a-dup", { name: "Dup" });
	const first = await ingest(headersA, deviceA.id, [original]);
	assert.equal(first.status, 200);
	assert.deepEqual(first.body.accepted, ["a-dup"]);

	const sameHub = await ingest(headersA, deviceA.id, [original]);
	assert.equal(sameHub.status, 200);
	assert.deepEqual(sameHub.body.accepted, ["a-dup"]);
	assert.equal(sameHub.body.rejected.length, 0);

	const otherHub = await ingest(deviceHeaders(deviceB.id, SECRET_B), deviceB.id, [original]);
	assert.equal(otherHub.status, 200);
	assert.deepEqual(otherHub.body.accepted, ["a-dup"]);
	assert.equal(otherHub.body.rejected.length, 0);
	assert.equal(eventRow("a-dup").owner_user_id, userA.id);
});

test("token ingest cannot use a linked hub's instance_id", async () => {
	const headersA = deviceHeaders(deviceA.id, SECRET_A);
	const seed = await ingest(headersA, deviceA.id, [event("a-inst", "heartbeat")]);
	assert.equal(seed.status, 200);
	const before = instanceRow(deviceA.id);
	assert.equal(before.owner_user_id, userA.id);
	assert.equal(before.device_id, deviceA.id);

	const res = await ingest(tokenHeaders(), deviceA.id, [
		event("tok-impersonate", "workflow.created", "wf-impersonate", { name: "nope" }),
	]);
	assert.equal(res.status, 403);
	assert.equal(res.body.error, "instance_owned_by_device");
	assert.equal(eventRow("tok-impersonate"), undefined);
	const after = instanceRow(deviceA.id);
	assert.equal(after.last_seen_at, before.last_seen_at);
	assert.equal(after.events_count, before.events_count);
});

test("events without workflow_id are not owner-checked", async () => {
	await ingest(deviceHeaders(deviceA.id, SECRET_A), deviceA.id, [
		event("a-wf-g", "workflow.created", "wf-a-g", { name: "A g" }),
	]);

	const heartbeat = await ingest(deviceHeaders(deviceB.id, SECRET_B), deviceB.id, [
		event("b-heartbeat", "heartbeat"),
	]);
	assert.equal(heartbeat.status, 200);
	assert.deepEqual(heartbeat.body.accepted, ["b-heartbeat"]);
	assert.equal(heartbeat.body.rejected.length, 0);
	assert.equal(eventRow("b-heartbeat").owner_user_id, userB.id);

	const tokenBeat = await ingest(tokenHeaders(), "inst-token-heartbeat", [event("tok-heartbeat", "heartbeat")]);
	assert.equal(tokenBeat.status, 200);
	assert.deepEqual(tokenBeat.body.accepted, ["tok-heartbeat"]);
	assert.equal(eventRow("tok-heartbeat").owner_user_id, null);
});

test("a mixed batch inserts valid events and rejects only mismatches", async () => {
	const seed = await ingest(deviceHeaders(deviceA.id, SECRET_A), deviceA.id, [
		event("a-mix", "workflow.created", "wf-a-mix", { name: "A mix" }),
	]);
	assert.equal(seed.status, 200);

	const mixed = await ingest(deviceHeaders(deviceB.id, SECRET_B), deviceB.id, [
		event("b-mix-beat", "heartbeat"),
		event("b-mix-steal", "step.started", "wf-a-mix", { step_id: "nope" }),
		event("b-mix-own", "workflow.created", "wf-b-mix", { name: "B mix" }),
	]);
	assert.equal(mixed.status, 200);
	assert.deepEqual(mixed.body.accepted.sort(), ["b-mix-beat", "b-mix-own"]);
	assert.equal(mixed.body.rejected.length, 1);
	assert.equal(mixed.body.rejected[0].id, "b-mix-steal");
	assert.equal(mixed.body.rejected[0].reason, "workflow_owner_mismatch");
	assert.ok(eventRow("b-mix-beat"));
	assert.ok(eventRow("b-mix-own"));
	assert.equal(eventRow("b-mix-steal"), undefined);
	assert.equal(eventRow("b-mix-own").owner_user_id, userB.id);
});
