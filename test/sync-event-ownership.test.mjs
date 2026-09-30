/**
 * POST /api/sync/events must not let one client write events for, or mirror
 * status into, a remote workflow owned by another client.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { authed, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-event-ownership-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.TARGET_DEVICE_LINKING_MODE = "legacy";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
const { enqueueCommand, upsertRemoteStep } = await import("../db.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

const cookie = await login(base);

async function registerClient(name) {
	const res = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name,
			capabilities: { commands: ["workflow.create", "workflow.delete", "step.add"], runners: [{ id: "claude", installed: true }] },
		}),
	});
	assert.equal(res.status, 201);
	const body = await res.json();
	return {
		id: body.client_id,
		headers: { authorization: `Bearer ${body.client_token}`, "content-type": "application/json" },
	};
}

/** Operator creates a remote workflow for `clientId` and plans one step on it. */
async function createRemote(clientId, name) {
	const res = await fetch(`${base}/api/sync/remote-workflows`, {
		method: "POST",
		headers: { "content-type": "application/json", ...authed(cookie) },
		body: JSON.stringify({ client_id: clientId, name, agent: "claude" }),
	});
	const body = await res.json();
	assert.equal(res.status, 201, JSON.stringify(body));
	const remoteId = body.remote_workflow.id;
	upsertRemoteStep({ remoteId, stepKey: "s1", orderIndex: 0, description: "First step" });
	return remoteId;
}

async function postEvents(client, events) {
	const res = await fetch(`${base}/api/sync/events`, {
		method: "POST",
		headers: client.headers,
		body: JSON.stringify({ events }),
	});
	assert.equal(res.status, 200);
	return res.json();
}

/** Raw rows, so the comparison covers every column rather than the mapped view. */
function snapshot(remoteId) {
	const handle = new DatabaseSync(tmpDb, { readOnly: true });
	try {
		return {
			workflow: handle.prepare("SELECT * FROM remote_workflows WHERE id = ?").get(remoteId),
			steps: handle.prepare("SELECT * FROM remote_workflow_steps WHERE remote_id = ? ORDER BY step_key").all(remoteId),
		};
	} finally {
		handle.close();
	}
}

function storedEventIds() {
	const handle = new DatabaseSync(tmpDb, { readOnly: true });
	try {
		return handle.prepare("SELECT id FROM sync_events ORDER BY id").all().map((row) => row.id);
	} finally {
		handle.close();
	}
}

const owner = await registerClient("Owner hub");
const intruder = await registerClient("Intruder hub");
const ownerRemote = await createRemote(owner.id, "Owner workflow");
const intruderRemote = await createRemote(intruder.id, "Intruder workflow");

test("event for the caller's own remote_id is accepted and mirrored", async () => {
	const result = await postEvents(intruder, [
		{ id: "own-status", type: "workflow.status_changed", remote_id: intruderRemote, payload: { to: "running" } },
		{ id: "own-step", type: "step.status_changed", remote_id: intruderRemote, payload: { step_key: "s1", to: "done" } },
	]);
	assert.deepEqual(result, { accepted: ["own-status", "own-step"], rejected: [], duplicates: [] });
	const after = snapshot(intruderRemote);
	assert.equal(after.workflow.status, "running");
	assert.equal(after.steps[0].status, "done");
	assert.equal(after.steps[0].on_client, 1);
	assert.ok(storedEventIds().includes("own-status"));
});

test("event for another client's remote_id is rejected, not stored and not mirrored", async () => {
	const before = snapshot(ownerRemote);
	const result = await postEvents(intruder, [
		{ id: "steal-status", type: "workflow.status_changed", remote_id: ownerRemote, payload: { to: "failed" } },
		{ id: "steal-step", type: "step.status_changed", remote_id: ownerRemote, payload: { step_key: "s1", to: "done" } },
	]);
	assert.deepEqual(result, {
		accepted: [],
		rejected: [
			{ id: "steal-status", reason: "foreign_remote_id" },
			{ id: "steal-step", reason: "foreign_remote_id" },
		],
		duplicates: [],
	});
	assert.deepEqual(snapshot(ownerRemote), before);
	const stored = storedEventIds();
	assert.ok(!stored.includes("steal-status"));
	assert.ok(!stored.includes("steal-step"));

	// A retry stays rejected rather than turning into a duplicate.
	const again = await postEvents(intruder, [
		{ id: "steal-status", type: "workflow.status_changed", remote_id: ownerRemote, payload: { to: "failed" } },
	]);
	assert.deepEqual(again.rejected, [{ id: "steal-status", reason: "foreign_remote_id" }]);
	assert.deepEqual(snapshot(ownerRemote), before);
});

test("command.ack event for another client's command is rejected and not mirrored", async () => {
	const deleteCommand = enqueueCommand({ clientId: owner.id, remoteId: ownerRemote, type: "workflow.delete", payload: {} });
	const before = snapshot(ownerRemote);
	const result = await postEvents(intruder, [
		{ id: "steal-ack", type: "command.ack", payload: { command_id: deleteCommand.id, status: "acked" } },
	]);
	assert.deepEqual(result, { accepted: [], rejected: [{ id: "steal-ack", reason: "foreign_remote_id" }], duplicates: [] });
	assert.ok(snapshot(ownerRemote).workflow, "owner's remote workflow must not be deleted");
	assert.deepEqual(snapshot(ownerRemote), before);
	assert.ok(!storedEventIds().includes("steal-ack"));
});

test("event without remote_id, or with an unknown remote_id, is accepted", async () => {
	const result = await postEvents(intruder, [
		{ id: "no-remote", type: "client.heartbeat", payload: { status: "idle" } },
		{ id: "unknown-remote", type: "workflow.created", remote_id: "rwf_not_on_server", payload: { name: "Local", origin: "local" } },
	]);
	assert.deepEqual(result, { accepted: ["no-remote", "unknown-remote"], rejected: [], duplicates: [] });
	const stored = storedEventIds();
	assert.ok(stored.includes("no-remote"));
	assert.ok(stored.includes("unknown-remote"));
});

test("mixed batch puts each event id in the right array", async () => {
	const before = snapshot(ownerRemote);
	const result = await postEvents(intruder, [
		{ id: "mix-own", type: "workflow.status_changed", remote_id: intruderRemote, payload: { to: "paused" } },
		{ id: "mix-foreign", type: "workflow.status_changed", remote_id: ownerRemote, payload: { to: "paused" } },
		{ id: "mix-none", type: "client.heartbeat", payload: { status: "busy" } },
		{ id: "own-status", type: "workflow.status_changed", remote_id: intruderRemote, payload: { to: "running" } },
	]);
	assert.deepEqual(result, {
		accepted: ["mix-own", "mix-none"],
		rejected: [{ id: "mix-foreign", reason: "foreign_remote_id" }],
		duplicates: ["own-status"],
	});
	assert.deepEqual(snapshot(ownerRemote), before);
	// The duplicate is not re-mirrored, so the status from mix-own sticks.
	assert.equal(snapshot(intruderRemote).workflow.status, "paused");
});

test("the owner can still post events for its own remote workflow", async () => {
	const result = await postEvents(owner, [
		{ id: "owner-status", type: "workflow.status_changed", remote_id: ownerRemote, payload: { to: "running" } },
	]);
	assert.deepEqual(result, { accepted: ["owner-status"], rejected: [], duplicates: [] });
	assert.equal(snapshot(ownerRemote).workflow.status, "running");
});
