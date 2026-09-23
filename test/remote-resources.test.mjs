import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-resources-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";
const { server } = await import("../server.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function register(name, capabilities) {
	const res = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, capabilities }),
	});
	assert.equal(res.status, 201);
	return res.json();
}

test("remote resource operations require a declared sync/v2 capability and are idempotent", async () => {
	const admin = await login(base);
	const legacy = await register("legacy", { commands: [] });
	const path = `${base}/api/sync/clients/${legacy.client_id}/templates`;
	const body = { resource: { id: "template-1", name: "Audit", data: { steps: [] } } };
	const unsupported = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: admin },
		body: JSON.stringify(body),
	});
	assert.equal(unsupported.status, 409);
	assert.equal((await fetch(path, { headers: { cookie: admin } })).status, 200);
	assert.deepEqual((await (await fetch(path, { headers: { cookie: admin } })).json()).resources, []);
	assert.deepEqual(
		(await (await fetch(`${base}/api/sync/commands`, { headers: { authorization: `Bearer ${legacy.client_token}` } })).json()).commands,
		[],
	);

	const capabilities = {
		resources: { version: 2, templates: true, tcp_tools: true, resource_sets: true },
		commands: ["template.upsert", "template.delete", "tcp-tool.upsert", "tcp-tool.delete", "resource-set.upsert", "resource-set.delete"],
	};
	const compatible = await register("v2", capabilities);
	const resourcePath = `${base}/api/sync/clients/${compatible.client_id}/templates`;
	const invalid = await fetch(resourcePath, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: admin },
		body: JSON.stringify({ resource: { id: "invalid", data: {} } }),
	});
	assert.equal(invalid.status, 422);
	const headers = { "content-type": "application/json", cookie: admin, "idempotency-key": "template-1-create" };
	const created = await fetch(resourcePath, { method: "POST", headers, body: JSON.stringify(body) });
	assert.equal(created.status, 201);
	const command = (await created.json()).command;
	const retry = await fetch(resourcePath, { method: "POST", headers, body: JSON.stringify(body) });
	assert.equal(retry.status, 200);
	assert.equal((await retry.json()).command.id, command.id);

	const listed = await (await fetch(resourcePath, { headers: { cookie: admin } })).json();
	assert.equal(listed.contract_version, "sync/v2");
	assert.deepEqual(listed.resources[0].data, { steps: [] });

	const roleResponse = await fetch(`${base}/api/auth/roles`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: admin },
		body: JSON.stringify({ name: "TCP operator", permissions: ["client.read", "client.tcp-tools.create"] }),
	});
	const role = (await roleResponse.json()).role;
	const inviteResponse = await fetch(`${base}/api/auth/users`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: admin },
		body: JSON.stringify({ email: "tcp-operator@example.com", role_id: role.id }),
	});
	const invite = await inviteResponse.json();
	const token = new URL(invite.invite.setupUrl).searchParams.get("token");
	const setup = await fetch(`${base}/api/auth/setup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, password: "tcp-operator-pass-12" }),
	});
	const tcpOperator = setup.headers.get("set-cookie")?.split(";")[0];
	const deniedTemplate = await fetch(resourcePath, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: tcpOperator },
		body: JSON.stringify(body),
	});
	assert.equal(deniedTemplate.status, 403);
	assert.deepEqual(await deniedTemplate.json(), { error: "forbidden", permission: "client.templates.create" });
	const tcpPath = `${base}/api/sync/clients/${compatible.client_id}/tcp-tools`;
	const tcpBody = { resource: { id: "tcp-1", name: "Browser", data: { command: "browser.open" } } };
	assert.equal(
		(await fetch(tcpPath, { method: "POST", headers: { "content-type": "application/json", cookie: tcpOperator }, body: JSON.stringify(tcpBody) })).status,
		201,
	);
	const deniedTcpEdit = await fetch(`${tcpPath}/tcp-1`, {
		method: "PATCH",
		headers: { "content-type": "application/json", cookie: tcpOperator },
		body: JSON.stringify(tcpBody),
	});
	assert.equal(deniedTcpEdit.status, 403);
	assert.deepEqual(await deniedTcpEdit.json(), { error: "forbidden", permission: "client.tcp-tools.edit" });
	const deniedTcpDelete = await fetch(`${tcpPath}/tcp-1`, { method: "DELETE", headers: { cookie: tcpOperator } });
	assert.equal(deniedTcpDelete.status, 403);
	assert.deepEqual(await deniedTcpDelete.json(), { error: "forbidden", permission: "client.tcp-tools.delete" });
	const rciPath = `${base}/api/sync/clients/${compatible.client_id}/resource-sets`;
	const rciBody = { resource: { id: "rci-1", name: "Project files", data: { paths: ["/tmp/project"] } } };
	const deniedRci = await fetch(rciPath, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: tcpOperator },
		body: JSON.stringify(rciBody),
	});
	assert.equal(deniedRci.status, 403);
	assert.deepEqual(await deniedRci.json(), { error: "forbidden", permission: "client.rci.create" });
	assert.equal(
		(await fetch(rciPath, { method: "POST", headers: { "content-type": "application/json", cookie: admin }, body: JSON.stringify(rciBody) })).status,
		201,
	);

	const poll = await fetch(`${base}/api/sync/commands`, { headers: { authorization: `Bearer ${compatible.client_token}` } });
	const delivered = (await poll.json()).commands;
	assert.equal(delivered.length, 3);
	assert.deepEqual(delivered.map((item) => item.type).sort(), ["resource-set.upsert", "tcp-tool.upsert", "template.upsert"]);
	const event = await fetch(`${base}/api/sync/events`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${compatible.client_token}` },
		body: JSON.stringify({ events: [{ id: "event-template-1", type: "template.upserted", payload: body }] }),
	});
	assert.equal(event.status, 200);
	const duplicate = await fetch(`${base}/api/sync/events`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${compatible.client_token}` },
		body: JSON.stringify({ events: [{ id: "event-template-1", type: "template.upserted", payload: body }] }),
	});
	assert.equal((await duplicate.json()).duplicates[0], "event-template-1");
	const afterDuplicate = await (await fetch(resourcePath, { headers: { cookie: admin } })).json();
	assert.equal(afterDuplicate.resources.length, 1);
	assert.equal(afterDuplicate.resources[0].revision, 2);

	const patched = await fetch(`${resourcePath}/template-1`, {
		method: "PATCH",
		headers: { "content-type": "application/json", cookie: admin },
		body: JSON.stringify({ resource: { id: "template-1", name: "Audit edited", data: { steps: [] } } }),
	});
	assert.equal(patched.status, 201);
	const deletedRci = await fetch(`${rciPath}/rci-1`, { method: "DELETE", headers: { cookie: admin } });
	assert.equal(deletedRci.status, 200);

	const deniedExport = await fetch(`${resourcePath}/export`, { headers: { cookie: tcpOperator } });
	assert.equal(deniedExport.status, 403);
	assert.deepEqual(await deniedExport.json(), { error: "forbidden", permission: "client.templates.export" });
	const deniedImport = await fetch(`${resourcePath}/import`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: tcpOperator },
		body: JSON.stringify({ resources: [body.resource] }),
	});
	assert.equal(deniedImport.status, 403);
	assert.deepEqual(await deniedImport.json(), { error: "forbidden", permission: "client.templates.import" });

	const exported = await fetch(`${resourcePath}/export`, { headers: { cookie: admin } });
	assert.equal(exported.status, 200);
	assert.match(exported.headers.get("content-disposition") ?? "", /templates-export\.json/);
	const bundle = await exported.json();
	assert.equal(bundle.contract_version, "sync/v2");
	assert.equal(bundle.domain, "templates");
	assert.deepEqual(bundle.resources, [{ id: "template-1", name: "Audit edited", data: { steps: [] } }]);
	assert.equal(JSON.stringify(bundle).includes("token"), false);

	const imported = await fetch(`${tcpPath}/import`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: admin, "idempotency-key": "tcp-import-1" },
		body: JSON.stringify({
			contract_version: "sync/v2",
			domain: "tcp_tools",
			resources: [{ id: "tcp-imported", name: "Imported browser", data: { command: "browser.open" } }],
		}),
	});
	assert.equal(imported.status, 201);
	const importedBody = await imported.json();
	assert.equal(importedBody.commands.length, 1);
	assert.equal(importedBody.commands[0].command.type, "tcp-tool.upsert");
	const importedAgain = await fetch(`${tcpPath}/import`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: admin, "idempotency-key": "tcp-import-1" },
		body: JSON.stringify({
			resources: [{ id: "tcp-imported", name: "Imported browser", data: { command: "browser.open" } }],
		}),
	});
	assert.equal(importedAgain.status, 200);
	assert.equal((await importedAgain.json()).commands[0].idempotent, true);
});
