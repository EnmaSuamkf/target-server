/**
 * Persist TCP/RCI selections on remote workflows and push them to the client.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { authed, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-rwf-selections-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { mergeResourceSelections, mergeTcpSelections } = await import("../db.mjs");
const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...authed(cookie) },
	body: JSON.stringify(body),
});

const RESOURCE_CAPABILITIES = {
	resources: { version: 2, templates: true, tcp_tools: true, resource_sets: true },
	commands: [
		"workflow.create",
		"step.add",
		"workflow.set_context",
		"workflow.set_selection",
		"tcp-tool.upsert",
		"resource-set.upsert",
	],
};

async function registerClient(name, capabilities = RESOURCE_CAPABILITIES) {
	const reg = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, capabilities }),
	});
	assert.equal(reg.status, 201);
	return reg.json();
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

async function createTcp(cookie, input) {
	const res = await fetch(`${base}/api/tcps`, json("POST", input, cookie));
	assert.equal(res.status, 201);
	return (await res.json()).tcp;
}

async function createResourceSet(cookie, input) {
	const res = await fetch(`${base}/api/resource-sets`, json("POST", input, cookie));
	assert.equal(res.status, 201);
	return (await res.json()).resourceSet;
}

async function createTemplate(cookie, input) {
	const res = await fetch(`${base}/api/templates`, json("POST", input, cookie));
	assert.equal(res.status, 201);
	return (await res.json()).template;
}

async function createRemoteWorkflow(cookie, body) {
	const res = await fetch(`${base}/api/sync/remote-workflows`, json("POST", body, cookie));
	assert.equal(res.status, 201);
	return res.json();
}

async function ackCommands(clientToken, commands) {
	for (const command of commands) {
		const ack = await fetch(`${base}/api/sync/commands/${command.id}/ack`, {
			method: "POST",
			headers: { authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
			body: JSON.stringify({ status: "applied", remote_id: command.remote_id }),
		});
		assert.equal(ack.status, 200);
	}
}

async function drainCommands(clientToken) {
	for (;;) {
		const poll = await fetch(`${base}/api/sync/commands`, {
			headers: { authorization: `Bearer ${clientToken}` },
		});
		assert.equal(poll.status, 200);
		const { commands } = await poll.json();
		if (!commands.length) return;
		await ackCommands(clientToken, commands);
	}
}

test("mergeTcpSelections / mergeResourceSelections: union by id; null names win", () => {
	assert.deepEqual(
		mergeTcpSelections(
			[{ tcpId: "a", toolNames: ["status"] }],
			[{ tcpId: "a", toolNames: ["log"] }, { tcpId: "b", toolNames: null }],
		),
		[
			{ tcpId: "a", toolNames: ["status", "log"] },
			{ tcpId: "b", toolNames: null },
		],
	);
	assert.deepEqual(
		mergeTcpSelections([{ tcpId: "a", toolNames: ["status"] }], [{ tcpId: "a", toolNames: null }]),
		[{ tcpId: "a", toolNames: null }],
	);
	assert.deepEqual(
		mergeResourceSelections(
			[{ resourceSetId: "s", resourceNames: ["docs"] }],
			[{ resourceSetId: "s", resourceNames: null }],
		),
		[{ resourceSetId: "s", resourceNames: null }],
	);
});

test("PUT /tcps and /resource-sets persist selections, enqueue upserts before set_selection, and expose them on the API", async () => {
	const cookie = await login(base);
	const { client_id, client_token } = await registerClient("Selection client");
	const tcp = await createTcp(cookie, {
		name: "Git pack",
		tools: [
			{ name: "status", requestTemplate: "git status" },
			{ name: "log", requestTemplate: "git log" },
		],
	});
	const resourceSet = await createResourceSet(cookie, {
		name: "Docs pack",
		resources: [
			{ name: "guide", kind: "doc", content: "# Guide" },
			{ name: "notes", kind: "doc", content: "# Notes" },
		],
	});
	const created = await createRemoteWorkflow(cookie, { client_id, name: "Needs catalogs" });
	assert.deepEqual(created.remote_workflow.tcp_selections, []);
	assert.deepEqual(created.remote_workflow.resource_selections, []);
	await drainCommands(client_token);

	const putTcps = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/tcps`,
		json("PUT", { tcp_selections: [{ tcpId: tcp.id, toolNames: ["status", "ghost"] }] }, cookie),
	);
	assert.equal(putTcps.status, 200);
	const tcpBody = await putTcps.json();
	assert.deepEqual(tcpBody.remote_workflow.tcp_selections, [{ tcpId: tcp.id, toolNames: ["status"] }]);
	assert.deepEqual(
		tcpBody.commands.map((command) => command.type),
		["tcp-tool.upsert", "workflow.set_selection"],
	);
	assert.ok(tcpBody.commands[0].sequence < tcpBody.commands[1].sequence);
	assert.equal(tcpBody.commands[0].payload.resource.id, tcp.id);
	assert.deepEqual(tcpBody.commands[0].payload.resource.data.tools.map((tool) => tool.name), ["status", "log"]);
	assert.deepEqual(tcpBody.commands[1].payload.tcp_selections, [{ tcpId: tcp.id, toolNames: ["status"] }]);

	const firstPoll = await fetch(`${base}/api/sync/commands`, {
		headers: { authorization: `Bearer ${client_token}` },
	});
	const firstDelivered = (await firstPoll.json()).commands;
	assert.deepEqual(
		firstDelivered.map((command) => command.type),
		["tcp-tool.upsert"],
	);
	assert.equal(firstDelivered[0].id, tcpBody.commands[0].id);
	assert.ok(!firstDelivered.some((command) => command.type === "workflow.set_selection"));
	await ackCommands(client_token, firstDelivered);
	await drainCommands(client_token);

	const putRci = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/resource-sets`,
		json("PUT", { resource_selections: [{ resourceSetId: resourceSet.id, resourceNames: ["guide"] }] }, cookie),
	);
	assert.equal(putRci.status, 200);
	const rciBody = await putRci.json();
	assert.deepEqual(rciBody.remote_workflow.tcp_selections, [{ tcpId: tcp.id, toolNames: ["status"] }]);
	assert.deepEqual(rciBody.remote_workflow.resource_selections, [
		{ resourceSetId: resourceSet.id, resourceNames: ["guide"] },
	]);
	assert.deepEqual(
		rciBody.commands.map((command) => command.type),
		["tcp-tool.upsert", "resource-set.upsert", "workflow.set_selection"],
	);
	assert.ok(rciBody.commands[0].sequence < rciBody.commands[1].sequence);
	assert.ok(rciBody.commands[1].sequence < rciBody.commands[2].sequence);
	assert.equal(rciBody.commands[1].payload.resource.id, resourceSet.id);
	assert.deepEqual(
		rciBody.commands[1].payload.resource.data.resources.map((resource) => resource.name),
		["guide", "notes"],
	);

	const secondPoll = await fetch(`${base}/api/sync/commands`, {
		headers: { authorization: `Bearer ${client_token}` },
	});
	const secondDelivered = (await secondPoll.json()).commands;
	assert.deepEqual(
		secondDelivered.map((command) => command.type),
		["tcp-tool.upsert"],
	);
	assert.ok(!secondDelivered.some((command) => command.type === "workflow.set_selection"));

	const listed = await (await fetch(`${base}/api/sync/remote-workflows`, { headers: authed(cookie) })).json();
	const row = listed.remote_workflows.find((workflow) => workflow.id === created.remote_workflow.id);
	assert.deepEqual(row.tcp_selections, [{ tcpId: tcp.id, toolNames: ["status"] }]);
	assert.deepEqual(row.resource_selections, [{ resourceSetId: resourceSet.id, resourceNames: ["guide"] }]);

	const detail = await (
		await fetch(`${base}/api/sync/remote-workflows/${created.remote_workflow.id}`, { headers: authed(cookie) })
	).json();
	assert.deepEqual(detail.remote_workflow.tcp_selections, [{ tcpId: tcp.id, toolNames: ["status"] }]);
	assert.deepEqual(detail.remote_workflow.resource_selections, [
		{ resourceSetId: resourceSet.id, resourceNames: ["guide"] },
	]);
	assert.deepEqual(
		detail.pending_commands.map((command) => command.type),
		["tcp-tool.upsert", "resource-set.upsert", "workflow.set_selection"],
	);
});

test("unknown catalog ids are rejected and unknown tool/resource names are dropped", async () => {
	const cookie = await login(base);
	const { client_id } = await registerClient("Validation client");
	const tcp = await createTcp(cookie, {
		name: "Only status",
		tools: [{ name: "status", requestTemplate: "git status" }],
	});
	const resourceSet = await createResourceSet(cookie, {
		name: "Only guide",
		resources: [{ name: "guide", kind: "doc", content: "# Guide" }],
	});
	const created = await createRemoteWorkflow(cookie, { client_id, name: "Validate me" });

	const unknownTcp = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/tcps`,
		json("PUT", { tcp_selections: [{ tcpId: "missing-tcp" }] }, cookie),
	);
	assert.equal(unknownTcp.status, 422);
	assert.deepEqual(await unknownTcp.json(), { error: "unknown_tcp:missing-tcp" });

	const unknownRci = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/resource-sets`,
		json("PUT", { resource_selections: [{ resourceSetId: "missing-rci" }] }, cookie),
	);
	assert.equal(unknownRci.status, 422);
	assert.deepEqual(await unknownRci.json(), { error: "unknown_resource_set:missing-rci" });

	const droppedTools = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/tcps`,
		json("PUT", { tcp_selections: [{ tcpId: tcp.id, toolNames: ["ghost"] }] }, cookie),
	);
	assert.equal(droppedTools.status, 200);
	assert.deepEqual((await droppedTools.json()).remote_workflow.tcp_selections, []);

	const droppedResources = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/resource-sets`,
		json("PUT", { resource_selections: [{ resourceSetId: resourceSet.id, resourceNames: ["ghost"] }] }, cookie),
	);
	assert.equal(droppedResources.status, 200);
	assert.deepEqual((await droppedResources.json()).remote_workflow.resource_selections, []);

	const missingWorkflow = await fetch(
		`${base}/api/sync/remote-workflows/does-not-exist/tcps`,
		json("PUT", { tcp_selections: [] }, cookie),
	);
	assert.equal(missingWorkflow.status, 404);
	assert.deepEqual(await missingWorkflow.json(), { error: "remote_workflow_not_found" });
});

test("client without resources capability gets 409 capability_unsupported and nothing is saved", async () => {
	const cookie = await login(base);
	const { client_id } = await registerClient("Legacy selection client", {
		commands: ["workflow.create", "step.add"],
	});
	const tcp = await createTcp(cookie, {
		name: "Blocked pack",
		tools: [{ name: "status", requestTemplate: "git status" }],
	});
	const resourceSet = await createResourceSet(cookie, {
		name: "Blocked docs",
		resources: [{ name: "guide", kind: "doc", content: "# Guide" }],
	});
	const created = await createRemoteWorkflow(cookie, { client_id, name: "No capability" });

	const putTcps = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/tcps`,
		json("PUT", { tcp_selections: [{ tcpId: tcp.id }] }, cookie),
	);
	assert.equal(putTcps.status, 409);
	const tcpError = await putTcps.json();
	assert.equal(tcpError.error, "capability_unsupported");
	assert.equal(tcpError.required.command, "tcp-tool.upsert");

	const putRci = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/resource-sets`,
		json("PUT", { resource_selections: [{ resourceSetId: resourceSet.id }] }, cookie),
	);
	assert.equal(putRci.status, 409);
	assert.equal((await putRci.json()).error, "capability_unsupported");

	const detail = await (
		await fetch(`${base}/api/sync/remote-workflows/${created.remote_workflow.id}`, { headers: authed(cookie) })
	).json();
	assert.deepEqual(detail.remote_workflow.tcp_selections, []);
	assert.deepEqual(detail.remote_workflow.resource_selections, []);
	assert.ok(!detail.pending_commands.some((command) => command.type === "workflow.set_selection"));

	const template = await createTemplate(cookie, {
		name: "Needs capability",
		steps: [{ description: "From template" }],
		tcpSelections: [{ tcpId: tcp.id }],
	});
	const deniedCreate = await fetch(
		`${base}/api/sync/remote-workflows`,
		json("POST", { client_id, name: "From template blocked", template_id: template.id }, cookie),
	);
	assert.equal(deniedCreate.status, 409);
	assert.equal((await deniedCreate.json()).error, "capability_unsupported");
	const listed = await (await fetch(`${base}/api/sync/remote-workflows`, { headers: authed(cookie) })).json();
	assert.ok(!listed.remote_workflows.some((workflow) => workflow.name === "From template blocked"));
});

test("template selections merge on create and on append", async () => {
	const cookie = await login(base);
	const { client_id } = await registerClient("Template merge client");
	const tcpA = await createTcp(cookie, {
		name: "Pack A",
		tools: [
			{ name: "status", requestTemplate: "git status" },
			{ name: "log", requestTemplate: "git log" },
		],
	});
	const tcpB = await createTcp(cookie, {
		name: "Pack B",
		tools: [{ name: "ping", requestTemplate: "ping" }],
	});
	const resourceSet = await createResourceSet(cookie, {
		name: "Docs",
		resources: [
			{ name: "guide", kind: "doc", content: "# Guide" },
			{ name: "notes", kind: "doc", content: "# Notes" },
		],
	});
	const seed = await createTemplate(cookie, {
		name: "Seed catalogs",
		steps: [{ description: "Seeded" }],
		tcpSelections: [{ tcpId: tcpA.id, toolNames: ["status"] }],
		resourceSelections: [{ resourceSetId: resourceSet.id, resourceNames: ["guide"] }],
	});
	const extra = await createTemplate(cookie, {
		name: "Extra catalogs",
		steps: [{ description: "Extra" }],
		tcpSelections: [
			{ tcpId: tcpA.id, toolNames: ["log"] },
			{ tcpId: tcpB.id, toolNames: null },
		],
		resourceSelections: [{ resourceSetId: resourceSet.id }],
	});

	const created = await createRemoteWorkflow(cookie, {
		client_id,
		name: "From seed template",
		template_id: seed.id,
	});
	assert.deepEqual(created.remote_workflow.tcp_selections, [{ tcpId: tcpA.id, toolNames: ["status"] }]);
	assert.deepEqual(created.remote_workflow.resource_selections, [
		{ resourceSetId: resourceSet.id, resourceNames: ["guide"] },
	]);
	assert.deepEqual(
		created.selection_commands.map((command) => command.type),
		["tcp-tool.upsert", "resource-set.upsert", "workflow.set_selection"],
	);
	assert.ok(created.step_commands.at(-1).sequence < created.selection_commands[0].sequence);
	assert.ok(created.selection_commands[0].sequence < created.selection_commands.at(-1).sequence);
	assert.equal(created.selection_commands.at(-1).type, "workflow.set_selection");

	const appended = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/steps/from-template`,
		json("POST", { template_id: extra.id }, cookie),
	);
	assert.equal(appended.status, 201);
	const appendBody = await appended.json();
	assert.deepEqual(appendBody.remote_workflow.tcp_selections, [
		{ tcpId: tcpA.id, toolNames: ["status", "log"] },
		{ tcpId: tcpB.id, toolNames: null },
	]);
	assert.deepEqual(appendBody.remote_workflow.resource_selections, [
		{ resourceSetId: resourceSet.id, resourceNames: null },
	]);
	assert.deepEqual(
		appendBody.selection_commands.map((command) => command.type),
		["tcp-tool.upsert", "tcp-tool.upsert", "resource-set.upsert", "workflow.set_selection"],
	);
	assert.equal(appendBody.selection_commands.at(-1).type, "workflow.set_selection");
	assert.deepEqual(appendBody.selection_commands.at(-1).payload.tcp_selections, [
		{ tcpId: tcpA.id, toolNames: ["status", "log"] },
		{ tcpId: tcpB.id, toolNames: null },
	]);
});

test("PUT selection routes require manage plus catalog read", async () => {
	const admin = await login(base);
	const { client_id } = await registerClient("Permission selection client");
	const created = await createRemoteWorkflow(admin, { client_id, name: "Locked" });
	const manager = await createLimitedOperator(admin, {
		email: "sel-manager@example.com",
		name: "Workflow manager no catalog",
		permissions: ["client.read", "client.workflows.manage"],
		password: "sel-manager-pass-12",
	});
	const deniedTcp = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/tcps`,
		json("PUT", { tcp_selections: [] }, manager),
	);
	assert.equal(deniedTcp.status, 403);
	assert.deepEqual(await deniedTcp.json(), { error: "forbidden", permission: "tcp-tools.read" });
	const deniedRci = await fetch(
		`${base}/api/sync/remote-workflows/${created.remote_workflow.id}/resource-sets`,
		json("PUT", { resource_selections: [] }, manager),
	);
	assert.equal(deniedRci.status, 403);
	assert.deepEqual(await deniedRci.json(), { error: "forbidden", permission: "rci.read" });
});
