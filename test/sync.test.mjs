/**
 * Integration test for the full remote-sync HTTP flow:
 * register → heartbeat → enqueue → poll → ack → events.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-int-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

test("sync integration: register → heartbeat → enqueue → poll → ack → events", async () => {
	const reg = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "Integration Client",
			instance_id: "inst_sync_integration",
			version: "0.2.0",
			capabilities: { commands: ["workflow.create", "step.add"] },
		}),
	});
	assert.equal(reg.status, 201);
	const { client_id, client_token } = await reg.json();
	assert.ok(client_id);
	assert.ok(client_token.startsWith("sync_"));

	const auth = { authorization: `Bearer ${client_token}`, "content-type": "application/json" };

	const hb = await fetch(`${base}/api/sync/heartbeat`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ status: "idle", version: "0.2.0", instance_id: "inst_sync_integration" }),
	});
	assert.equal(hb.status, 200);
	const hbBody = await hb.json();
	assert.equal(hbBody.ok, true);
	assert.ok(hbBody.server_time);

	const {
		enqueueCommand,
		getCommandById,
		getClientById,
		createRemoteWorkflow,
		getRemoteWorkflowById,
		listSyncEvents,
	} = await import("../db.mjs");

	const remoteId = "rwf_integration_1";
	createRemoteWorkflow({ id: remoteId, clientId: client_id, name: "Integration workflow", status: "pending" });
	const cmd = enqueueCommand({
		id: "cmd_integration_1",
		clientId: client_id,
		remoteId,
		type: "workflow.create",
		payload: { name: "Integration workflow", workdir: "/tmp/integration" },
	});
	assert.equal(cmd.status, "pending");

	const poll = await fetch(`${base}/api/sync/commands`, { headers: auth });
	assert.equal(poll.status, 200);
	const { commands } = await poll.json();
	assert.equal(commands.length, 1);
	assert.equal(commands[0].id, "cmd_integration_1");
	assert.equal(commands[0].type, "workflow.create");
	assert.equal(commands[0].remote_id, remoteId);
	assert.equal(commands[0].status, "delivered");

	const localId = "wf-local-integration-1";
	const ack = await fetch(`${base}/api/sync/commands/cmd_integration_1/ack`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ status: "applied", local_id: localId, remote_id: remoteId }),
	});
	assert.equal(ack.status, 200);
	const ackBody = await ack.json();
	assert.equal(ackBody.command_id, "cmd_integration_1");
	assert.equal(ackBody.status, "acked");

	const storedCmd = getCommandById("cmd_integration_1");
	assert.equal(storedCmd.status, "acked");
	assert.ok(storedCmd.ackedAt);

	const remoteWorkflow = getRemoteWorkflowById(remoteId);
	assert.equal(remoteWorkflow.localId, localId);

	const emptyPoll = await fetch(`${base}/api/sync/commands`, { headers: auth });
	assert.equal((await emptyPoll.json()).commands.length, 0);

	const eventsRes = await fetch(`${base}/api/sync/events`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify({
			batch_id: "batch-integration-1",
			events: [
				{
					id: "evt_integration_1",
					type: "workflow.created",
					remote_id: remoteId,
					payload: { name: "Integration workflow", origin: "remote", workdir: "/tmp/integration" },
				},
				{
					id: "evt_integration_2",
					type: "command.ack",
					remote_id: remoteId,
					payload: { command_id: "cmd_integration_1", status: "acked" },
				},
			],
		}),
	});
	assert.equal(eventsRes.status, 200);
	const eventsBody = await eventsRes.json();
	assert.deepEqual(eventsBody.accepted.sort(), ["evt_integration_1", "evt_integration_2"]);
	assert.equal(eventsBody.rejected.length, 0);

	const storedEvents = listSyncEvents({ clientId: client_id, remoteId });
	assert.equal(storedEvents.length, 2);
	assert.ok(storedEvents.some((e) => e.type === "workflow.created"));
	assert.ok(storedEvents.some((e) => e.type === "command.ack"));

	const client = getClientById(client_id);
	assert.equal(client.capabilities?.availability, "idle");
	assert.ok(client.lastSeenAt);
});
