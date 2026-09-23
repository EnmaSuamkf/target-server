/**
 * Server catalog templates expanded into remote workflows (create + append).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { authed, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-rwf-templates-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...authed(cookie) },
	body: JSON.stringify(body),
});

async function registerClient(name = "Template Client") {
	const reg = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name,
			capabilities: { commands: ["workflow.create", "step.add", "workflow.set_context"] },
		}),
	});
	assert.equal(reg.status, 201);
	return reg.json();
}

async function createTemplate(cookie, input) {
	const res = await fetch(`${base}/api/templates`, json("POST", input, cookie));
	assert.equal(res.status, 201);
	return (await res.json()).template;
}

async function createLimitedOperator(adminCookie, { email, name, permissions, password }) {
	const roleResponse = await fetch(`${base}/api/auth/roles`, json("POST", { name, permissions }, adminCookie));
	const role = (await roleResponse.json()).role;
	const inviteResponse = await fetch(`${base}/api/auth/users`, json("POST", { email, role_id: role.id }, adminCookie));
	const invite = await inviteResponse.json();
	const token = new URL(invite.invite.setupUrl).searchParams.get("token");
	const setup = await fetch(`${base}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, password }),
	});
	return setup.headers.get("set-cookie")?.split(";")[0];
}

test("create remote workflow from template enqueues commands in order with mapped fields", async () => {
	const cookie = await login(base);
	const { client_id } = await registerClient("Create-from-template client");
	const template = await createTemplate(cookie, {
		name: "Remote seed",
		steps: [
			{
				description: "First from template",
				acceptanceCriteria: "Looks good",
				manualReview: true,
				useSubagent: false,
				maxRetries: 3,
				retryIntervalSeconds: 15,
				notes: [{ content: "Watch the logs", theme: "warning" }],
			},
			{
				description: "Second from template",
				useSubagent: true,
			},
		],
	});
	assert.equal(template.steps.length, 2);
	assert.equal(template.steps[0].notes[0].content, "Watch the logs");

	const create = await fetch(
		`${base}/api/sync/remote-workflows`,
		json(
			"POST",
			{
				client_id,
				name: "From catalog template",
				conversation_context: "Background for every step.",
				template_id: template.id,
			},
			cookie,
		),
	);
	assert.equal(create.status, 201);
	const created = await create.json();
	assert.equal(created.command.type, "workflow.create");
	assert.equal(created.context_command.type, "workflow.set_context");
	assert.equal(created.step_commands.length, 2);
	assert.equal(created.remote_workflow.step_count, 2);

	const stepKeys = created.step_commands.map((c) => c.payload.step_key);
	assert.equal(new Set(stepKeys).size, 2);
	assert.deepEqual(stepKeys, ["step-1", "step-2"]);
	assert.equal(created.command.sequence, 1);
	assert.equal(created.context_command.sequence, 2);
	assert.equal(created.step_commands[0].sequence, 3);
	assert.equal(created.step_commands[1].sequence, 4);
	assert.equal(created.step_commands[0].type, "step.add");
	assert.equal(created.step_commands[1].type, "step.add");

	assert.equal(created.step_commands[0].payload.description, "First from template");
	assert.equal(created.step_commands[0].payload.acceptance_criteria, "Looks good");
	assert.equal(created.step_commands[0].payload.manual_review, true);
	assert.equal(created.step_commands[0].payload.use_subagent, false);
	assert.equal(created.step_commands[0].payload.max_retries, 3);
	assert.equal(created.step_commands[0].payload.retry_interval_seconds, 15);
	assert.equal(created.step_commands[0].payload.notes.length, 1);
	assert.equal(created.step_commands[0].payload.notes[0].content, "Watch the logs");
	assert.equal(created.step_commands[0].payload.notes[0].theme, "warning");
	assert.ok(created.step_commands[0].payload.notes[0].id);
	assert.equal(created.step_commands[1].payload.description, "Second from template");
	assert.equal(created.step_commands[1].payload.use_subagent, true);

	const detail = await fetch(`${base}/api/sync/remote-workflows/${created.remote_workflow.id}`, {
		headers: authed(cookie),
	});
	assert.equal(detail.status, 200);
	const detailBody = await detail.json();
	assert.equal(detailBody.steps.length, 2);
	assert.deepEqual(
		detailBody.steps.map((s) => s.step_key),
		["step-1", "step-2"],
	);
	assert.equal(detailBody.steps[0].description, "First from template");
	assert.equal(detailBody.steps[0].acceptance_criteria, "Looks good");
	assert.equal(detailBody.steps[0].manual_review, true);
	assert.equal(detailBody.steps[0].use_subagent, false);
	assert.equal(detailBody.steps[0].max_retries, 3);
	assert.equal(detailBody.steps[0].retry_interval_seconds, 15);
	assert.deepEqual(
		detailBody.pending_commands.map((c) => c.type),
		["workflow.create", "workflow.set_context", "step.add", "step.add"],
	);
});

test("create remote workflow with unknown template_id returns 404", async () => {
	const cookie = await login(base);
	const { client_id } = await registerClient("Unknown-template client");
	const res = await fetch(
		`${base}/api/sync/remote-workflows`,
		json(
			"POST",
			{ client_id, name: "Missing template", template_id: "does-not-exist" },
			cookie,
		),
	);
	assert.equal(res.status, 404);
	assert.deepEqual(await res.json(), { error: "unknown_template" });
});

test("create remote workflow with template requires templates.read", async () => {
	const admin = await login(base);
	const { client_id } = await registerClient("Permission-template client");
	const template = await createTemplate(admin, {
		name: "Needs read",
		steps: [{ description: "Only step" }],
	});
	const creator = await createLimitedOperator(admin, {
		email: "tpl-creator@example.com",
		name: "Workflow creator no templates",
		permissions: ["client.read", "client.workflows.create"],
		password: "tpl-creator-pass-12",
	});
	const denied = await fetch(
		`${base}/api/sync/remote-workflows`,
		json("POST", { client_id, name: "Denied template", template_id: template.id }, creator),
	);
	assert.equal(denied.status, 403);
	assert.deepEqual(await denied.json(), { error: "forbidden", permission: "templates.read" });

	const plain = await fetch(
		`${base}/api/sync/remote-workflows`,
		json("POST", { client_id, name: "Plain still allowed" }, creator),
	);
	assert.equal(plain.status, 201);
});

test("append from-template adds every step each time with distinct keys", async () => {
	const cookie = await login(base);
	const { client_id } = await registerClient("Append-template client");
	const template = await createTemplate(cookie, {
		name: "Append me",
		steps: [
			{ description: "Alpha", notes: [{ content: "from append", theme: "success" }] },
			{ description: "Beta" },
		],
	});
	const created = await fetch(
		`${base}/api/sync/remote-workflows`,
		json("POST", { client_id, name: "Empty then append" }, cookie),
	);
	assert.equal(created.status, 201);
	const remoteId = (await created.json()).remote_workflow.id;

	const first = await fetch(
		`${base}/api/sync/remote-workflows/${remoteId}/steps/from-template`,
		json("POST", { template_id: template.id }, cookie),
	);
	assert.equal(first.status, 201);
	const firstBody = await first.json();
	assert.equal(firstBody.commands.length, 2);
	assert.equal(firstBody.steps.length, 2);
	assert.deepEqual(
		firstBody.commands.map((c) => c.payload.step_key),
		["step-1", "step-2"],
	);
	assert.equal(firstBody.commands[0].payload.notes[0].content, "from append");

	const second = await fetch(
		`${base}/api/sync/remote-workflows/${remoteId}/steps/from-template`,
		json("POST", { template_id: template.id }, cookie),
	);
	assert.equal(second.status, 201);
	const secondBody = await second.json();
	assert.equal(secondBody.commands.length, 2);
	assert.equal(secondBody.steps.length, 4);
	const allKeys = secondBody.steps.map((s) => s.step_key);
	assert.equal(new Set(allKeys).size, 4);
	assert.deepEqual(allKeys, ["step-1", "step-2", "step-3", "step-4"]);
	assert.deepEqual(
		secondBody.steps.map((s) => s.description),
		["Alpha", "Beta", "Alpha", "Beta"],
	);

	const unknown = await fetch(
		`${base}/api/sync/remote-workflows/${remoteId}/steps/from-template`,
		json("POST", { template_id: "missing" }, cookie),
	);
	assert.equal(unknown.status, 404);
	assert.deepEqual(await unknown.json(), { error: "unknown_template" });
});
