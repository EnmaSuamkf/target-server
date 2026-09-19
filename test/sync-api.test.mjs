/**
 * End-to-end test for client-facing sync API routes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-api-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.TARGET_DEVICE_LINKING_MODE = "legacy";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

test("sync API: register → heartbeat → poll → ack", async () => {
	const reg = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "Test Client",
			instance_id: "inst_sync_test",
			capabilities: { commands: ["workflow.create"] },
		}),
	});
	assert.equal(reg.status, 201);
	const { client_id, client_token, created_at } = await reg.json();
	assert.ok(client_id);
	assert.ok(client_token.startsWith("sync_"));
	assert.ok(created_at);

	const auth = { authorization: `Bearer ${client_token}`, "content-type": "application/json" };

	const hb = await fetch(`${base}/api/sync/heartbeat`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ status: "idle", version: "0.2.0" }),
	});
	assert.equal(hb.status, 200);
	const hbBody = await hb.json();
	assert.equal(hbBody.ok, true);
	assert.ok(hbBody.server_time);

	const { enqueueCommand, getCommandById } = await import("../db.mjs");
	const remoteId = "rwf_e2e_1";
	const cmd = enqueueCommand({
		id: "cmd_e2e_1",
		clientId: client_id,
		remoteId,
		type: "workflow.create",
		payload: { name: "Remote workflow" },
	});
	assert.equal(cmd.status, "pending");

	const poll = await fetch(`${base}/api/sync/commands`, { headers: auth });
	assert.equal(poll.status, 200);
	const { commands } = await poll.json();
	assert.equal(commands.length, 1);
	assert.equal(commands[0].id, "cmd_e2e_1");
	assert.equal(commands[0].type, "workflow.create");
	assert.equal(commands[0].remote_id, remoteId);
	assert.equal(commands[0].status, "delivered");

	const ack = await fetch(`${base}/api/sync/commands/cmd_e2e_1/ack`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ status: "applied", local_id: "wf-local-1", remote_id: remoteId }),
	});
	assert.equal(ack.status, 200);
	const ackBody = await ack.json();
	assert.equal(ackBody.command_id, "cmd_e2e_1");
	assert.equal(ackBody.status, "acked");
	assert.equal(ackBody.already_recorded, false);

	const updated = getCommandById("cmd_e2e_1");
	assert.equal(updated.status, "acked");
	assert.ok(updated.ackedAt);

	const empty = await fetch(`${base}/api/sync/commands`, { headers: auth });
	assert.equal(empty.status, 200);
	const emptyBody = await empty.json();
	assert.equal(emptyBody.commands.length, 0);
});

test("sync API: events batch ingest with dedup", async () => {
	const reg = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "Events Client" }),
	});
	const { client_token } = await reg.json();
	const auth = { authorization: `Bearer ${client_token}`, "content-type": "application/json" };

	const body = {
		batch_id: "batch-1",
		events: [
			{
				id: "evt_1",
				type: "workflow.created",
				remote_id: "rwf_1",
				payload: { name: "A", origin: "remote" },
			},
			{ id: "evt_2", type: "workflow.status_changed", payload: { to: "running" } },
		],
	};
	const res = await fetch(`${base}/api/sync/events`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify(body),
	});
	assert.equal(res.status, 200);
	const result = await res.json();
	assert.deepEqual(result.accepted.sort(), ["evt_1", "evt_2"]);
	assert.equal(result.rejected.length, 0);
	assert.equal(result.duplicates.length, 0);

	const bad = await fetch(`${base}/api/sync/events`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify({
			events: [{ id: "evt_bad", type: "workflow.created", payload: { origin: "remote" } }],
		}),
	});
	assert.equal(bad.status, 400);
	const badBody = await bad.json();
	assert.ok(badBody.errors.some((e) => e.field.includes("name")));

	const again = await fetch(`${base}/api/sync/events`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify(body),
	});
	const dup = await again.json();
	assert.equal(dup.accepted.length, 0);
	assert.deepEqual(dup.duplicates.sort(), ["evt_1", "evt_2"]);
});

test("sync API: rejects unauthenticated sync routes", async () => {
	const res = await fetch(`${base}/api/sync/commands`);
	assert.equal(res.status, 401);
});
