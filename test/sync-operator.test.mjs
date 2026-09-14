/**
 * End-to-end test for operator-facing sync API routes (JWT auth).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { authed, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-sync-operator-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

test("operator sync: create remote workflow and client receives command", async () => {
	const cookie = await login(base);

	const reg = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "Operator Test Client",
			capabilities: {
				commands: ["workflow.create", "step.add"],
				runners: [
					{ id: "claude", installed: true },
					{ id: "free-code", installed: false },
				],
			},
		}),
	});
	assert.equal(reg.status, 201);
	const { client_id, client_token } = await reg.json();
	const clientAuth = { authorization: `Bearer ${client_token}`, "content-type": "application/json" };

	const create = await fetch(`${base}/api/sync/remote-workflows`, {
		method: "POST",
		headers: { ...authed(cookie), "content-type": "application/json" },
		body: JSON.stringify({
			client_id,
			name: "Remote from dashboard",
			conversation_context: "Background for every step.",
			agent: "claude",
		}),
	});
	assert.equal(create.status, 201);
	const created = await create.json();
	assert.ok(created.remote_workflow.id);
	assert.equal(created.remote_workflow.client_id, client_id);
	assert.equal(created.remote_workflow.name, "Remote from dashboard");
	assert.equal(created.remote_workflow.status, "pending");
	assert.equal(created.command.type, "workflow.create");
	assert.equal(created.command.remote_id, created.remote_workflow.id);
	assert.equal(created.command.status, "pending");
	assert.deepEqual(created.command.payload, {
		name: "Remote from dashboard",
		sandbox: "docker",
		agent: "claude",
	});
	assert.equal(created.remote_workflow.agent, "claude");
	assert.ok(created.context_command);
	assert.equal(created.context_command.type, "workflow.set_context");
	assert.equal(created.remote_workflow.sandbox, "docker");
	assert.equal(created.remote_workflow.step_count, 0);

	const poll = await fetch(`${base}/api/sync/commands`, { headers: clientAuth });
	assert.equal(poll.status, 200);
	const { commands } = await poll.json();
	assert.equal(commands.length, 1);
	assert.equal(commands[0].id, created.command.id);
	assert.equal(commands[0].type, "workflow.create");
	assert.equal(commands[0].remote_id, created.remote_workflow.id);
	assert.equal(commands[0].status, "delivered");

	const listClients = await fetch(`${base}/api/sync/clients`, { headers: authed(cookie) });
	assert.equal(listClients.status, 200);
	const clientsBody = await listClients.json();
	assert.equal(clientsBody.clients.length, 1);
	assert.equal(clientsBody.clients[0].id, client_id);
	assert.equal(clientsBody.clients[0].token_hash, undefined);
	assert.deepEqual(clientsBody.clients[0].capabilities.runners, [
		{ id: "claude", installed: true },
		{ id: "free-code", installed: false },
	]);

	const badAgent = await fetch(`${base}/api/sync/remote-workflows`, {
		method: "POST",
		headers: { ...authed(cookie), "content-type": "application/json" },
		body: JSON.stringify({ client_id, name: "Bad agent", agent: "free-code" }),
	});
	assert.equal(badAgent.status, 422);

	const listWorkflows = await fetch(`${base}/api/sync/remote-workflows`, { headers: authed(cookie) });
	assert.equal(listWorkflows.status, 200);
	const workflowsBody = await listWorkflows.json();
	assert.equal(workflowsBody.remote_workflows.length, 1);
	assert.equal(workflowsBody.remote_workflows[0].id, created.remote_workflow.id);

	const ack = await fetch(`${base}/api/sync/commands/${created.command.id}/ack`, {
		method: "POST",
		headers: clientAuth,
		body: JSON.stringify({
			status: "applied",
			local_id: "wf-local-op-1",
			remote_id: created.remote_workflow.id,
		}),
	});
	assert.equal(ack.status, 200);

	const enqueueStep = await fetch(`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/commands`, {
		method: "POST",
		headers: { ...authed(cookie), "content-type": "application/json" },
		body: JSON.stringify({
			type: "step.add",
			payload: {
				step_key: "s1",
				description: "First step from operator",
				acceptance_criteria: "Step completes cleanly",
				manual_review: true,
				use_subagent: true,
				max_retries: 2,
				retry_interval_seconds: 5,
			},
		}),
	});
	assert.equal(enqueueStep.status, 201);
	const stepBody = await enqueueStep.json();
	assert.equal(stepBody.command.type, "step.add");
	assert.equal(stepBody.command.sequence, 3);

	const detail = await fetch(`${base}/api/sync/remote-workflows/${created.remote_workflow.id}`, {
		headers: authed(cookie),
	});
	assert.equal(detail.status, 200);
	const detailBody = await detail.json();
	assert.equal(detailBody.steps.length, 1);
	assert.equal(detailBody.steps[0].step_key, "s1");
	assert.equal(detailBody.steps[0].manual_review, true);
	assert.equal(detailBody.steps[0].max_retries, 2);
	assert.equal(detailBody.remote_workflow.step_count, 1);
	assert.ok(Array.isArray(detailBody.pending_commands));

	const saveSelection = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/run-selection`,
		{
			method: "PATCH",
			headers: { ...authed(cookie), "content-type": "application/json" },
			body: JSON.stringify({ step_keys: ["s1"] }),
		},
	);
	assert.equal(saveSelection.status, 200);
	const selectionBody = await saveSelection.json();
	assert.deepEqual(selectionBody.step_keys, ["s1"]);
	assert.equal(selectionBody.steps[0].run_selected, true);

	const start = await fetch(`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/commands`, {
		method: "POST",
		headers: { ...authed(cookie), "content-type": "application/json" },
		body: JSON.stringify({ type: "workflow.start", payload: { step_keys: ["s1"] } }),
	});
	assert.equal(start.status, 201);
	const startBody = await start.json();
	assert.deepEqual(startBody.command.payload.step_keys, ["s1"]);
	const detailAfterStart = await fetch(`${base}/api/sync/remote-workflows/${created.remote_workflow.id}`, {
		headers: authed(cookie),
	});
	const detailAfterStartBody = await detailAfterStart.json();
	const pendingStart = detailAfterStartBody.pending_commands.find((c) => c.type === "workflow.start");
	assert.ok(pendingStart);
	assert.equal(pendingStart.status, "pending");
	assert.deepEqual(pendingStart.payload.step_keys, ["s1"]);

	const poll2 = await fetch(`${base}/api/sync/commands`, { headers: clientAuth });
	assert.equal(poll2.status, 200);
	const { commands: commands2 } = await poll2.json();
	assert.equal(commands2.length, 1);
	assert.equal(commands2[0].type, "workflow.set_context");
	assert.equal(commands2[0].status, "delivered");

	const ackContext = await fetch(`${base}/api/sync/commands/${commands2[0].id}/ack`, {
		method: "POST",
		headers: clientAuth,
		body: JSON.stringify({
			status: "applied",
			local_id: "wf-local-op-1",
			remote_id: created.remote_workflow.id,
		}),
	});
	assert.equal(ackContext.status, 200);

	const poll3 = await fetch(`${base}/api/sync/commands`, { headers: clientAuth });
	const { commands: commands3 } = await poll3.json();
	assert.equal(commands3.length, 1);
	assert.equal(commands3[0].type, "step.add");
	assert.equal(commands3[0].status, "delivered");

	const del = await fetch(`${base}/api/sync/remote-workflows/${created.remote_workflow.id}`, {
		method: "DELETE",
		headers: authed(cookie),
	});
	assert.equal(del.status, 200);
	const delBody = await del.json();
	assert.equal(delBody.command.type, "workflow.delete");
});

test("operator sync: rejects unauthenticated operator routes", async () => {
	const res = await fetch(`${base}/api/sync/clients`);
	assert.equal(res.status, 401);
});
