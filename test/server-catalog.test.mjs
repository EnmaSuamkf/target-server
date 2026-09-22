import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-server-catalog-")), "t.db");
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
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
	body: JSON.stringify(body),
});

function remoteResourceCount() {
	const db = new DatabaseSync(tmpDb);
	const row = db.prepare("SELECT COUNT(*) AS n FROM remote_resources").get();
	db.close();
	return row.n;
}

async function inviteSession(admin, { email, permissions, password }) {
	const roleRes = await fetch(`${base}/api/auth/roles`, json("POST", { name: email, permissions }, admin));
	assert.equal(roleRes.status, 201);
	const role = (await roleRes.json()).role;
	const inviteRes = await fetch(`${base}/api/auth/users`, json("POST", { email, role_id: role.id }, admin));
	assert.equal(inviteRes.status, 201);
	const invite = await inviteRes.json();
	const token = new URL(invite.invite.setupUrl).searchParams.get("token");
	const setup = await fetch(`${base}/api/auth/setup`, json("POST", { token, password }));
	assert.equal(setup.status, 200);
	return setup.headers.get("set-cookie")?.split(";")[0];
}

test("catalog APIs support CRUD, selections, TCP token export, and do not write remote_resources", async () => {
	const admin = await login(base);
	assert.equal(remoteResourceCount(), 0);

	const tcpRes = await fetch(
		`${base}/api/tcps`,
		json(
			"POST",
			{
				name: "Git pack",
				tags: ["vcs"],
				tools: [
					{
						name: "status",
						description: "git status",
						requestTemplate: "git status",
						inputs: [{ name: "cwd", placeholder: "$CWD", description: "working tree" }],
						tokens: { API_KEY: "super-secret" },
					},
				],
			},
			admin,
		),
	);
	assert.equal(tcpRes.status, 201);
	const tcp = (await tcpRes.json()).tcp;
	assert.ok(tcp.id);
	assert.equal(tcp.tools[0].tokens.API_KEY, "super-secret");

	const listedTcps = await (await fetch(`${base}/api/tcps`, { headers: { cookie: admin } })).json();
	assert.equal(listedTcps.tcps.length, 1);
	const gotTcp = await (await fetch(`${base}/api/tcps/${tcp.id}`, { headers: { cookie: admin } })).json();
	assert.equal(gotTcp.tcp.name, "Git pack");

	const patchedTcp = await fetch(`${base}/api/tcps/${tcp.id}`, json("PATCH", { name: "Git tools" }, admin));
	assert.equal(patchedTcp.status, 200);
	assert.equal((await patchedTcp.json()).tcp.name, "Git tools");

	const rciRes = await fetch(
		`${base}/api/resource-sets`,
		json(
			"POST",
			{
				name: "Docs pack",
				tags: ["docs"],
				resources: [
					{
						name: "onboarding",
						description: "intro",
						kind: "doc",
						entryFile: "guide.md",
						content: "# Hello",
						files: [{ path: "extra.md", content: "more" }],
					},
				],
			},
			admin,
		),
	);
	assert.equal(rciRes.status, 201);
	const resourceSet = (await rciRes.json()).resourceSet;
	assert.equal(resourceSet.resources[0].kind, "doc");
	assert.equal((await (await fetch(`${base}/api/resource-sets`, { headers: { cookie: admin } })).json()).resourceSets.length, 1);
	assert.equal((await (await fetch(`${base}/api/resource-sets/${resourceSet.id}`, { headers: { cookie: admin } })).json()).resourceSet.name, "Docs pack");
	const patchedRci = await fetch(`${base}/api/resource-sets/${resourceSet.id}`, json("PATCH", { name: "Docs" }, admin));
	assert.equal(patchedRci.status, 200);
	assert.equal((await patchedRci.json()).resourceSet.name, "Docs");

	const templateRes = await fetch(
		`${base}/api/templates`,
		json(
			"POST",
			{
				name: "Review checklist",
				tags: ["qa"],
				steps: [
					{
						description: "Review the change",
						acceptanceCriteria: "Checklist is complete",
						useSubagent: true,
						manualReview: false,
						maxRetries: 1,
						retryIntervalSeconds: 5,
					},
				],
				tcpSelections: [{ tcpId: tcp.id, toolNames: ["status"] }],
				resourceSelections: [{ resourceSetId: resourceSet.id }],
			},
			admin,
		),
	);
	assert.equal(templateRes.status, 201);
	const template = (await templateRes.json()).template;
	assert.deepEqual(template.tcpIds, [tcp.id]);
	assert.equal(template.tcpSelections[0].tcpId, tcp.id);
	assert.equal(template.resourceSelections[0].resourceSetId, resourceSet.id);
	assert.equal((await (await fetch(`${base}/api/templates`, { headers: { cookie: admin } })).json()).templates.length, 1);
	const gotTemplate = await (await fetch(`${base}/api/templates/${template.id}`, { headers: { cookie: admin } })).json();
	assert.equal(gotTemplate.template.tcpSelections[0].tcpId, tcp.id);
	assert.equal(gotTemplate.template.resourceSelections[0].resourceSetId, resourceSet.id);
	const patchedTemplate = await fetch(`${base}/api/templates/${template.id}`, json("PATCH", { name: "QA checklist" }, admin));
	assert.equal(patchedTemplate.status, 200);
	assert.equal((await patchedTemplate.json()).template.name, "QA checklist");

	const extra = await fetch(`${base}/api/templates`, json("POST", { name: "Disposable" }, admin));
	const extraId = (await extra.json()).template.id;
	assert.equal((await fetch(`${base}/api/templates/${extraId}`, { method: "DELETE", headers: { cookie: admin } })).status, 200);
	assert.equal((await fetch(`${base}/api/templates/${extraId}`, { headers: { cookie: admin } })).status, 404);

	const extraTcp = await fetch(`${base}/api/tcps`, json("POST", { name: "Disposable tcp", tools: [{ name: "x", requestTemplate: "x" }] }, admin));
	const extraTcpId = (await extraTcp.json()).tcp.id;
	assert.equal((await fetch(`${base}/api/tcps/${extraTcpId}`, { method: "DELETE", headers: { cookie: admin } })).status, 200);

	const extraRci = await fetch(`${base}/api/resource-sets`, json("POST", { name: "Disposable rci" }, admin));
	const extraRciId = (await extraRci.json()).resourceSet.id;
	assert.equal((await fetch(`${base}/api/resource-sets/${extraRciId}`, { method: "DELETE", headers: { cookie: admin } })).status, 200);

	assert.equal(remoteResourceCount(), 0);
});

test("catalog routes return 401 without a session and 403 without the matching permission", async () => {
	assert.equal((await fetch(`${base}/api/templates`)).status, 401);
	assert.equal((await fetch(`${base}/api/tcps`)).status, 401);
	assert.equal((await fetch(`${base}/api/resource-sets`)).status, 401);
	assert.equal((await fetch(`${base}/api/templates`, json("POST", { name: "Nope" }))).status, 401);

	const admin = await login(base);
	const viewer = await inviteSession(admin, {
		email: "catalog-viewer@example.com",
		permissions: ["activity.read"],
		password: "catalog-viewer-12",
	});
	const deniedRead = await fetch(`${base}/api/templates`, { headers: { cookie: viewer } });
	assert.equal(deniedRead.status, 403);
	assert.deepEqual(await deniedRead.json(), { error: "forbidden", permission: "templates.read" });
	const deniedCreate = await fetch(`${base}/api/templates`, json("POST", { name: "Nope" }, viewer));
	assert.equal(deniedCreate.status, 403);
	assert.deepEqual(await deniedCreate.json(), { error: "forbidden", permission: "templates.create" });
	const deniedTcp = await fetch(`${base}/api/tcps`, json("POST", { name: "Nope", tools: [{ name: "x", requestTemplate: "x" }] }, viewer));
	assert.equal(deniedTcp.status, 403);
	assert.deepEqual(await deniedTcp.json(), { error: "forbidden", permission: "tcp-tools.create" });
	const deniedRci = await fetch(`${base}/api/resource-sets`, json("POST", { name: "Nope" }, viewer));
	assert.equal(deniedRci.status, 403);
	assert.deepEqual(await deniedRci.json(), { error: "forbidden", permission: "rci.create" });
});

test("catalog validation returns 422, including RCI paths with ..", async () => {
	const admin = await login(base);
	const missingName = await fetch(`${base}/api/templates`, json("POST", { tags: ["x"] }, admin));
	assert.equal(missingName.status, 422);
	const missingTcp = await fetch(`${base}/api/tcps`, json("POST", { tools: [] }, admin));
	assert.equal(missingTcp.status, 422);
	const traversal = await fetch(
		`${base}/api/resource-sets`,
		json(
			"POST",
			{
				name: "Bad path",
				resources: [
					{
						name: "secret",
						kind: "doc",
						entryFile: "ok.md",
						content: "x",
						files: [{ path: "../etc/passwd", content: "nope" }],
					},
				],
			},
			admin,
		),
	);
	assert.equal(traversal.status, 422);
	assert.ok((await traversal.json()).errors);
	const entryTraversal = await fetch(
		`${base}/api/resource-sets`,
		json(
			"POST",
			{
				name: "Bad entry",
				resources: [{ name: "secret", kind: "doc", entryFile: "../SKILL.md", content: "x" }],
			},
			admin,
		),
	);
	assert.equal(entryTraversal.status, 422);
});

test("catalog import mints new UUIDs and TCP export blanks token values", async () => {
	const admin = await login(base);
	const created = await fetch(
		`${base}/api/tcps`,
		json(
			"POST",
			{
				name: "Token pack",
				tools: [{ name: "echo", requestTemplate: "echo hi", tokens: { TOKEN: "keep-me" } }],
			},
			admin,
		),
	);
	const tcp = (await created.json()).tcp;
	const exported = await fetch(`${base}/api/tcps/${tcp.id}/export`, { headers: { cookie: admin } });
	assert.equal(exported.status, 200);
	const bundle = await exported.json();
	assert.equal(bundle.kind, "target.tcps");
	assert.equal(bundle.tcps[0].tools[0].tokens.TOKEN, "");
	const stored = await (await fetch(`${base}/api/tcps/${tcp.id}`, { headers: { cookie: admin } })).json();
	assert.equal(stored.tcp.tools[0].tokens.TOKEN, "keep-me");

	const importedTcp = await fetch(`${base}/api/tcps/import`, json("POST", bundle, admin));
	assert.equal(importedTcp.status, 201);
	const importedPacks = (await importedTcp.json()).tcps;
	assert.equal(importedPacks.length, 1);
	assert.notEqual(importedPacks[0].id, tcp.id);

	const templateExport = await fetch(`${base}/api/templates/export`, { headers: { cookie: admin } });
	assert.equal(templateExport.status, 200);
	const templateBundle = await templateExport.json();
	assert.equal(templateBundle.kind, "target.templates");
	const importedTemplates = await fetch(`${base}/api/templates/import`, json("POST", templateBundle, admin));
	assert.equal(importedTemplates.status, 201);
	const newTemplates = (await importedTemplates.json()).templates;
	assert.ok(newTemplates.length >= 1);
	const existingIds = new Set((await (await fetch(`${base}/api/templates`, { headers: { cookie: admin } })).json()).templates.map((item) => item.id));
	for (const item of newTemplates) assert.ok(existingIds.has(item.id));

	const rciExport = await fetch(`${base}/api/resource-sets/export`, { headers: { cookie: admin } });
	assert.equal(rciExport.status, 200);
	const rciBundle = await rciExport.json();
	assert.equal(rciBundle.kind, "target-server.resource-sets");
	const beforeRci = (await (await fetch(`${base}/api/resource-sets`, { headers: { cookie: admin } })).json()).resourceSets.map((item) => item.id);
	const importedRci = await fetch(`${base}/api/resource-sets/import`, json("POST", rciBundle, admin));
	assert.equal(importedRci.status, 201);
	const newSets = (await importedRci.json()).resourceSets;
	assert.ok(newSets.length >= 1);
	for (const item of newSets) assert.equal(beforeRci.includes(item.id), false);

	assert.equal(remoteResourceCount(), 0);
});
