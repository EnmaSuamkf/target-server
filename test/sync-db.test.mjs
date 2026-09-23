/**
 * Unit tests for the remote sync storage layer (clients, commands, events).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-db-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;

const {
	open,
	upsertClient,
	listClients,
	listOnlineClients,
	isSyncClientOnline,
	SYNC_CLIENT_ONLINE_TTL_MS,
	enqueueCommand,
	claimPendingCommands,
	ackCommand,
	insertSyncEvent,
	listRemoteWorkflows,
	createRemoteWorkflow,
	mirrorCommandToPlan,
	applyCommandAckToPlan,
	getRemoteWorkflowDetail,
	getRemoteWorkflowById,
	listRemoteSteps,
	nextRemoteStepKey,
	updateRemoteWorkflowStatus,
} = await import("../db.mjs");

test("sync layer: insert client, enqueue command, claim and ack it", () => {
	open();
	const now = new Date().toISOString();

	const client = upsertClient({
		id: "cli_test_1",
		name: "Ada Machine",
		tokenHash: "scrypt$test$hash",
		capabilities: { commands: ["workflow.create", "workflow.start"] },
		lastSeenAt: now,
	});
	assert.equal(client.id, "cli_test_1");
	assert.equal(client.name, "Ada Machine");
	assert.deepEqual(client.capabilities, { commands: ["workflow.create", "workflow.start"] });

	const clients = listClients();
	assert.equal(clients.length, 1);
	assert.equal(clients[0].id, "cli_test_1");

	const command = enqueueCommand({
		id: "cmd_test_1",
		clientId: client.id,
		remoteId: "rwf_test_1",
		type: "workflow.create",
		payload: { name: "Remote refactor", workdir: "/home/ada/project" },
	});
	assert.equal(command.status, "pending");
	assert.equal(command.sequence, 1);
	assert.equal(command.type, "workflow.create");

	const claimed = claimPendingCommands(client.id, { limit: 5 });
	assert.equal(claimed.length, 1);
	assert.equal(claimed[0].id, "cmd_test_1");
	assert.equal(claimed[0].status, "delivered");
	assert.deepEqual(claimed[0].payload, { name: "Remote refactor", workdir: "/home/ada/project" });

	const empty = claimPendingCommands(client.id);
	assert.equal(empty.length, 0);

	const ack = ackCommand({ commandId: command.id, clientId: client.id, status: "acked" });
	assert.equal(ack.ok, true);
	assert.equal(ack.command.status, "acked");
	assert.ok(ack.command.ackedAt);

	const eventResult = insertSyncEvent({
		id: "evt_test_1",
		clientId: client.id,
		remoteId: "rwf_test_1",
		type: "workflow.created",
		payload: { local_workflow_id: "wf-local-1" },
	});
	assert.equal(eventResult, "inserted");
	assert.equal(
		insertSyncEvent({
			id: "evt_test_1",
			clientId: client.id,
			type: "workflow.created",
			payload: {},
		}),
		"duplicate",
	);

	assert.deepEqual(listRemoteWorkflows(), []);
});

test("nextRemoteStepKey skips gaps after removals", () => {
	assert.equal(nextRemoteStepKey([]), "step-1");
	assert.equal(nextRemoteStepKey(["step-1", "step-3"]), "step-4");
	assert.equal(nextRemoteStepKey(["s1", "custom"]), "step-1");
});

test("remote workflow plan: mirror step.add into remote_workflow_steps", () => {
	const remoteId = "rwf_plan_1";
	createRemoteWorkflow({ id: remoteId, clientId: "cli_test_1", name: "Plan test", sandbox: "docker" });
	mirrorCommandToPlan({
		remoteId,
		type: "step.add",
		payload: {
			step_key: "s1",
			description: "Do the thing",
			acceptance_criteria: "Looks good",
			manual_review: true,
			max_retries: 1,
		},
	});
	const detail = getRemoteWorkflowDetail(remoteId);
	assert.equal(detail.steps.length, 1);
	assert.equal(detail.steps[0].stepKey, "s1");
	assert.equal(detail.steps[0].manualReview, true);
	assert.equal(detail.steps[0].maxRetries, 1);
	assert.equal(detail.workflow.sandbox, "docker");
});

test("remote workflow plan: step.edit marks on_client pending until acked", () => {
	const remoteId = "rwf_edit_sync";
	createRemoteWorkflow({ id: remoteId, clientId: "cli_test_1", name: "Edit sync", sandbox: "docker" });
	mirrorCommandToPlan({
		remoteId,
		type: "step.add",
		payload: { step_key: "s1", description: "Original" },
	});
	const addCmd = enqueueCommand({
		clientId: "cli_test_1",
		remoteId,
		type: "step.add",
		payload: { step_key: "s1", description: "Original" },
	});
	ackCommand({ commandId: addCmd.id, clientId: "cli_test_1", status: "acked" });
	applyCommandAckToPlan({ remoteId, type: "step.add", status: "acked", payload: { step_key: "s1" } });
	assert.equal(listRemoteSteps(remoteId)[0].onClient, true);

	mirrorCommandToPlan({
		remoteId,
		type: "step.edit",
		payload: { step_key: "s1", description: "Updated" },
	});
	enqueueCommand({
		clientId: "cli_test_1",
		remoteId,
		type: "step.edit",
		payload: { step_key: "s1", description: "Updated" },
	});
	assert.equal(listRemoteSteps(remoteId)[0].onClient, false);
	assert.equal(listRemoteSteps(remoteId)[0].description, "Updated");

	const listed = listRemoteWorkflows().find((w) => w.id === remoteId);
	assert.equal(listed?.stepsPendingSync, 1);
});

test("command sequencing: second command waits until first is acked", () => {
	const clientId = "cli_test_2";
	upsertClient({ id: clientId, name: "Seq Client", tokenHash: "hash2" });
	const remoteId = "rwf_test_2";

	enqueueCommand({ clientId, remoteId, type: "workflow.create", payload: { name: "A" } });
	enqueueCommand({ clientId, remoteId, type: "step.add", payload: { step_key: "s1", description: "First step" } });

	const firstClaim = claimPendingCommands(clientId);
	assert.equal(firstClaim.length, 1);
	assert.equal(firstClaim[0].type, "workflow.create");

	const blocked = claimPendingCommands(clientId);
	assert.equal(blocked.length, 0);

	ackCommand({ commandId: firstClaim[0].id, clientId, status: "acked" });

	const secondClaim = claimPendingCommands(clientId);
	assert.equal(secondClaim.length, 1);
	assert.equal(secondClaim[0].type, "step.add");
	assert.equal(secondClaim[0].sequence, 2);
});

test("workflow.delete failed with already-gone error removes the remote workflow", () => {
	const clientId = "cli_delete_gone";
	const remoteId = "rwf_delete_gone";
	upsertClient({ id: clientId, name: "Gone Client", tokenHash: "hash_gone" });
	createRemoteWorkflow({ id: remoteId, clientId, name: "Already gone", sandbox: "docker" });
	updateRemoteWorkflowStatus(remoteId, "deleting");
	const delCmd = enqueueCommand({ clientId, remoteId, type: "workflow.delete", payload: {} });
	ackCommand({ commandId: delCmd.id, clientId, status: "failed" });
	applyCommandAckToPlan({
		...delCmd,
		status: "failed",
		ackError: "remote workflow 'rwf_delete_gone' is not mapped locally",
	});
	assert.equal(getRemoteWorkflowById(remoteId), null);
});

test("listOnlineClients hides clients without a recent heartbeat", () => {
	assert.equal(SYNC_CLIENT_ONLINE_TTL_MS, 30_000);
	const clientId = "cli_offline";
	upsertClient({
		id: clientId,
		name: "Stale",
		tokenHash: "hash_off",
		lastSeenAt: new Date(Date.now() - 45_000).toISOString(),
	});
	assert.equal(listOnlineClients().some((c) => c.id === clientId), false);
	upsertClient({
		id: clientId,
		name: "Fresh",
		tokenHash: "hash_off",
		lastSeenAt: new Date().toISOString(),
	});
	assert.equal(listOnlineClients().some((c) => c.id === clientId), true);
	assert.equal(isSyncClientOnline(listClients().find((c) => c.id === clientId), Date.now()), true);
});

test("workflow.delete ack removes the remote workflow from the server plan", () => {
	const clientId = "cli_delete";
	const remoteId = "rwf_delete";
	upsertClient({ id: clientId, name: "Delete Client", tokenHash: "hash_del" });
	createRemoteWorkflow({ id: remoteId, clientId, name: "Gone", sandbox: "docker" });
	mirrorCommandToPlan({
		remoteId,
		type: "step.add",
		payload: { step_key: "s1", description: "Only step" },
	});
	updateRemoteWorkflowStatus(remoteId, "deleting");
	const delCmd = enqueueCommand({ clientId, remoteId, type: "workflow.delete", payload: {} });
	ackCommand({ commandId: delCmd.id, clientId, status: "acked" });
	applyCommandAckToPlan({ ...delCmd, status: "acked" });
	assert.equal(getRemoteWorkflowById(remoteId), null);
	assert.equal(listRemoteSteps(remoteId).length, 0);
	assert.equal(listRemoteWorkflows().some((w) => w.id === remoteId), false);
});
