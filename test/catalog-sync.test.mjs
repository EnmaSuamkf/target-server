import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { DEFAULT_ADMIN_EMAIL, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-catalog-sync-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.TARGET_DEVICE_LINKING_MODE = "optional";
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

function linkDevice({ requestId, ownerUserId, secret }) {
	db.createDeviceLinkRequest({
		id: requestId,
		deviceName: "Catalog sync hub",
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
		deviceId: `dev-${requestId}`,
		deviceSecretHash: hashToken(secret),
		consumedAt: "2026-01-01T00:00:01.000Z",
	});
}

async function registerLinkedHub({ requestId, ownerUserId, secret }) {
	linkDevice({ requestId, ownerUserId, secret });
	const headers = { authorization: `Target-Device v1 dev-${requestId}.${secret}`, "content-type": "application/json" };
	const register = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name: requestId }),
	});
	assert.equal(register.status, 201);
	return headers;
}

async function pullCatalog(headers) {
	return fetch(`${base}/api/sync/catalog`, { headers });
}

function assertNoSyncRoleIds(value) {
	assert.equal(JSON.stringify(value).includes("syncRoleIds"), false);
}

function seedCatalog({ listedRoleId, otherRoleId }) {
	const listedTcp = db.createTcp({
		name: "Listed tcp",
		tags: ["listed"],
		tools: [{ name: "echo", requestTemplate: "echo hi", tokens: { TOKEN: "keep-me" } }],
		syncRoleIds: [listedRoleId],
	});
	const hiddenTcp = db.createTcp({
		name: "Hidden tcp",
		tools: [{ name: "secret", requestTemplate: "secret" }],
		syncRoleIds: [otherRoleId],
	});
	const emptyTcp = db.createTcp({
		name: "Empty tcp",
		tools: [{ name: "noop", requestTemplate: "noop" }],
		syncRoleIds: [],
	});
	const listedRci = db.createResourceSet({
		name: "Listed rci",
		tags: ["listed"],
		resources: [{ name: "guide", kind: "doc", content: "# listed" }],
		syncRoleIds: [listedRoleId],
	});
	const hiddenRci = db.createResourceSet({
		name: "Hidden rci",
		resources: [{ name: "hidden", kind: "doc", content: "# hidden" }],
		syncRoleIds: [otherRoleId],
	});
	const emptyRci = db.createResourceSet({ name: "Empty rci", syncRoleIds: [] });
	const listedTemplate = db.createTemplate({
		name: "Listed template",
		tags: ["listed"],
		steps: [{ description: "Do the listed work" }],
		tcpSelections: [{ tcpId: listedTcp.id }, { tcpId: hiddenTcp.id }],
		resourceSelections: [{ resourceSetId: listedRci.id }, { resourceSetId: hiddenRci.id }],
		syncRoleIds: [listedRoleId],
	});
	const hiddenTemplate = db.createTemplate({
		name: "Hidden template",
		steps: [{ description: "Hidden" }],
		syncRoleIds: [otherRoleId],
	});
	const emptyTemplate = db.createTemplate({ name: "Empty template", syncRoleIds: [] });
	return {
		listedTcp,
		hiddenTcp,
		emptyTcp,
		listedRci,
		hiddenRci,
		emptyRci,
		listedTemplate,
		hiddenTemplate,
		emptyTemplate,
	};
}

test("GET /api/sync/catalog is 401 without credentials", async () => {
	assert.equal((await fetch(`${base}/api/sync/catalog`)).status, 401);
});

test("legacy token client cannot pull the catalog", async () => {
	const register = await fetch(`${base}/api/sync/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "Legacy catalog client" }),
	});
	assert.equal(register.status, 201);
	const { client_token } = await register.json();
	const res = await pullCatalog({ authorization: `Bearer ${client_token}` });
	assert.equal(res.status, 403);
	assert.deepEqual(await res.json(), { error: "owner_required" });
});

test("linked catalog pull respects permissions, allowlists, admin bypass and selection filtering", async () => {
	await login(base);
	const other = db.createRole({ name: "Other catalog role", permissions: ["activity.read"] });
	const listed = db.createRole({
		name: "Listed catalog syncer",
		permissions: ["client.templates.sync", "client.tcp-tools.sync", "client.rci.sync"],
	});
	const templatesOnly = db.createRole({ name: "Templates only syncer", permissions: ["client.templates.sync"] });
	const tcpOnly = db.createRole({ name: "TCP only syncer", permissions: ["client.tcp-tools.sync"] });
	const rciOnly = db.createRole({ name: "RCI only syncer", permissions: ["client.rci.sync"] });
	const noSync = db.createRole({ name: "No catalog sync", permissions: ["client.read"] });

	const catalog = seedCatalog({ listedRoleId: listed.id, otherRoleId: other.id });
	db.updateTemplate(catalog.listedTemplate.id, { syncRoleIds: [listed.id, templatesOnly.id] });
	db.updateTcp(catalog.listedTcp.id, { syncRoleIds: [listed.id, tcpOnly.id] });
	db.updateResourceSet(catalog.listedRci.id, { syncRoleIds: [listed.id, rciOnly.id] });

	const listedUser = db.createAuthUser({ email: "catalog-listed@example.test", roleId: listed.id });
	const templatesUser = db.createAuthUser({ email: "catalog-templates@example.test", roleId: templatesOnly.id });
	const tcpUser = db.createAuthUser({ email: "catalog-tcp@example.test", roleId: tcpOnly.id });
	const rciUser = db.createAuthUser({ email: "catalog-rci@example.test", roleId: rciOnly.id });
	const noSyncUser = db.createAuthUser({ email: "catalog-nosync@example.test", roleId: noSync.id });
	const adminUser = db.getAuthUserByEmail(DEFAULT_ADMIN_EMAIL);

	const listedHeaders = await registerLinkedHub({ requestId: "catalog-listed", ownerUserId: listedUser.id, secret: "listed-secret" });
	const listedRes = await pullCatalog(listedHeaders);
	assert.equal(listedRes.status, 200);
	const listedBody = await listedRes.json();
	assert.equal(listedBody.contract_version, "catalog-sync/v1");
	assert.equal(typeof listedBody.server_time, "string");
	assert.equal(listedBody.owner_id, listedUser.id);
	assert.deepEqual(listedBody.allowed, { templates: true, tcp_tools: true, resource_sets: true });
	assert.deepEqual(listedBody.templates.map((item) => item.id), [catalog.listedTemplate.id]);
	assert.deepEqual(listedBody.tcp_tools.map((item) => item.id), [catalog.listedTcp.id]);
	assert.deepEqual(listedBody.resource_sets.map((item) => item.id), [catalog.listedRci.id]);
	assert.deepEqual(listedBody.templates[0].data.tcpSelections.map((selection) => selection.tcpId), [catalog.listedTcp.id]);
	assert.deepEqual(listedBody.templates[0].data.resourceSelections.map((selection) => selection.resourceSetId), [catalog.listedRci.id]);
	assert.equal(listedBody.tcp_tools[0].data.tools[0].tokens.TOKEN, "keep-me");
	assert.equal(listedBody.templates[0].data.tags.join(","), "listed");
	assertNoSyncRoleIds(listedBody);

	const templatesHeaders = await registerLinkedHub({
		requestId: "catalog-templates",
		ownerUserId: templatesUser.id,
		secret: "templates-secret",
	});
	const templatesBody = await (await pullCatalog(templatesHeaders)).json();
	assert.deepEqual(templatesBody.allowed, { templates: true, tcp_tools: false, resource_sets: false });
	assert.deepEqual(templatesBody.templates.map((item) => item.id), [catalog.listedTemplate.id]);
	assert.deepEqual(templatesBody.tcp_tools, []);
	assert.deepEqual(templatesBody.resource_sets, []);
	assert.deepEqual(templatesBody.templates[0].data.tcpSelections, []);
	assert.deepEqual(templatesBody.templates[0].data.resourceSelections, []);

	const tcpHeaders = await registerLinkedHub({ requestId: "catalog-tcp", ownerUserId: tcpUser.id, secret: "tcp-secret" });
	const tcpBody = await (await pullCatalog(tcpHeaders)).json();
	assert.deepEqual(tcpBody.allowed, { templates: false, tcp_tools: true, resource_sets: false });
	assert.deepEqual(tcpBody.templates, []);
	assert.deepEqual(tcpBody.tcp_tools.map((item) => item.id), [catalog.listedTcp.id]);
	assert.deepEqual(tcpBody.resource_sets, []);

	const rciHeaders = await registerLinkedHub({ requestId: "catalog-rci", ownerUserId: rciUser.id, secret: "rci-secret" });
	const rciBody = await (await pullCatalog(rciHeaders)).json();
	assert.deepEqual(rciBody.allowed, { templates: false, tcp_tools: false, resource_sets: true });
	assert.deepEqual(rciBody.templates, []);
	assert.deepEqual(rciBody.tcp_tools, []);
	assert.deepEqual(rciBody.resource_sets.map((item) => item.id), [catalog.listedRci.id]);

	const noneHeaders = await registerLinkedHub({ requestId: "catalog-none", ownerUserId: noSyncUser.id, secret: "none-secret" });
	const noneBody = await (await pullCatalog(noneHeaders)).json();
	assert.deepEqual(noneBody.allowed, { templates: false, tcp_tools: false, resource_sets: false });
	assert.deepEqual(noneBody.templates, []);
	assert.deepEqual(noneBody.tcp_tools, []);
	assert.deepEqual(noneBody.resource_sets, []);

	const adminHeaders = await registerLinkedHub({ requestId: "catalog-admin", ownerUserId: adminUser.id, secret: "admin-secret" });
	const adminRes = await pullCatalog(adminHeaders);
	assert.equal(adminRes.status, 200);
	const adminBody = await adminRes.json();
	assert.deepEqual(adminBody.allowed, { templates: true, tcp_tools: true, resource_sets: true });
	const adminTemplateIds = adminBody.templates.map((item) => item.id);
	assert.ok(adminTemplateIds.includes(catalog.listedTemplate.id));
	assert.ok(adminTemplateIds.includes(catalog.hiddenTemplate.id));
	assert.ok(adminTemplateIds.includes(catalog.emptyTemplate.id));
	const adminTcpIds = adminBody.tcp_tools.map((item) => item.id);
	assert.ok(adminTcpIds.includes(catalog.listedTcp.id));
	assert.ok(adminTcpIds.includes(catalog.hiddenTcp.id));
	assert.ok(adminTcpIds.includes(catalog.emptyTcp.id));
	const adminRciIds = adminBody.resource_sets.map((item) => item.id);
	assert.ok(adminRciIds.includes(catalog.listedRci.id));
	assert.ok(adminRciIds.includes(catalog.hiddenRci.id));
	assert.ok(adminRciIds.includes(catalog.emptyRci.id));
	const adminListed = adminBody.templates.find((item) => item.id === catalog.listedTemplate.id);
	assert.deepEqual(
		adminListed.data.tcpSelections.map((selection) => selection.tcpId).sort(),
		[catalog.hiddenTcp.id, catalog.listedTcp.id].sort(),
	);
	assert.deepEqual(
		adminListed.data.resourceSelections.map((selection) => selection.resourceSetId).sort(),
		[catalog.hiddenRci.id, catalog.listedRci.id].sort(),
	);
	assertNoSyncRoleIds(adminBody);
});
