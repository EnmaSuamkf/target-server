import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { DEFAULT_ADMIN_EMAIL, login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-catalog-sync-roles-")), "t.db");
process.env.TARGET_SERVER_DB = tmpDb;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.TARGET_MAIL_TRANSPORT = "file";
process.env.TARGET_SKIP_UI_STALE_CHECK = "1";

const { server } = await import("../server.mjs");
const db = await import("../db.mjs");
if (!server.listening) await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const json = (method, body, cookie) => ({
	method,
	headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
	body: JSON.stringify(body),
});

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
	return { cookie: setup.headers.get("set-cookie")?.split(";")[0], role, user: invite.user };
}

function countSyncRoleRows({ domain, resourceId, roleId } = {}) {
	const sqlite = new DatabaseSync(tmpDb);
	let sql = "SELECT COUNT(*) AS n FROM catalog_sync_roles";
	const params = [];
	const where = [];
	if (domain) {
		where.push("domain = ?");
		params.push(domain);
	}
	if (resourceId) {
		where.push("resource_id = ?");
		params.push(resourceId);
	}
	if (roleId) {
		where.push("role_id = ?");
		params.push(roleId);
	}
	if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
	const row = sqlite.prepare(sql).get(...params);
	sqlite.close();
	return row.n;
}

function assertNoSyncRoleIds(value) {
	if (value && typeof value === "object") {
		assert.equal(Object.hasOwn(value, "syncRoleIds"), false, "export bundle must not include syncRoleIds");
		for (const nested of Object.values(value)) assertNoSyncRoleIds(nested);
	} else if (Array.isArray(value)) {
		for (const nested of value) assertNoSyncRoleIds(nested);
	}
}

const DOMAINS = [
	{
		path: "/api/templates",
		listKey: "templates",
		itemKey: "template",
		createBody: { name: "Sync template" },
		tableDomain: "templates",
	},
	{
		path: "/api/tcps",
		listKey: "tcps",
		itemKey: "tcp",
		createBody: { name: "Sync tcp", tools: [{ name: "echo", requestTemplate: "echo" }] },
		tableDomain: "tcps",
	},
	{
		path: "/api/resource-sets",
		listKey: "resourceSets",
		itemKey: "resourceSet",
		createBody: { name: "Sync rci" },
		tableDomain: "resource_sets",
	},
];

test("syncRoleIds CRUD round-trips for templates, tcps and resource sets", async () => {
	const admin = await login(base);
	const roleA = (await (await fetch(`${base}/api/auth/roles`, json("POST", { name: "Allow A", permissions: ["activity.read"] }, admin))).json()).role;
	const roleB = (await (await fetch(`${base}/api/auth/roles`, json("POST", { name: "Allow B", permissions: ["activity.read"] }, admin))).json()).role;

	for (const spec of DOMAINS) {
		const created = await fetch(`${base}${spec.path}`, json("POST", { ...spec.createBody, syncRoleIds: [roleB.id, roleA.id] }, admin));
		assert.equal(created.status, 201, spec.path);
		const item = (await created.json())[spec.itemKey];
		assert.deepEqual(item.syncRoleIds, [roleA.id, roleB.id].sort());

		const listed = await (await fetch(`${base}${spec.path}`, { headers: { cookie: admin } })).json();
		const fromList = listed[spec.listKey].find((entry) => entry.id === item.id);
		assert.deepEqual(fromList.syncRoleIds, item.syncRoleIds);

		const got = await (await fetch(`${base}${spec.path}/${item.id}`, { headers: { cookie: admin } })).json();
		assert.deepEqual(got[spec.itemKey].syncRoleIds, item.syncRoleIds);

		const renamed = await fetch(`${base}${spec.path}/${item.id}`, json("PATCH", { name: `${spec.createBody.name} renamed` }, admin));
		assert.equal(renamed.status, 200);
		assert.deepEqual((await renamed.json())[spec.itemKey].syncRoleIds, item.syncRoleIds);

		const replaced = await fetch(`${base}${spec.path}/${item.id}`, json("PATCH", { syncRoleIds: [roleA.id] }, admin));
		assert.equal(replaced.status, 200);
		assert.deepEqual((await replaced.json())[spec.itemKey].syncRoleIds, [roleA.id]);

		const cleared = await fetch(`${base}${spec.path}/${item.id}`, json("PATCH", { syncRoleIds: [] }, admin));
		assert.equal(cleared.status, 200);
		assert.deepEqual((await cleared.json())[spec.itemKey].syncRoleIds, []);
		assert.equal(countSyncRoleRows({ domain: spec.tableDomain, resourceId: item.id }), 0);
	}
});

test("unknown sync role id is 422 unknown_role", async () => {
	const admin = await login(base);
	for (const spec of DOMAINS) {
		const created = await fetch(`${base}${spec.path}`, json("POST", { ...spec.createBody, name: `${spec.createBody.name} unknown`, syncRoleIds: ["missing-role"] }, admin));
		assert.equal(created.status, 422, spec.path);
		assert.deepEqual(await created.json(), { error: "unknown_role", roleId: "missing-role" });

		const ok = await fetch(`${base}${spec.path}`, json("POST", { ...spec.createBody, name: `${spec.createBody.name} for patch` }, admin));
		assert.equal(ok.status, 201);
		const id = (await ok.json())[spec.itemKey].id;
		const patched = await fetch(`${base}${spec.path}/${id}`, json("PATCH", { syncRoleIds: ["still-missing"] }, admin));
		assert.equal(patched.status, 422);
		assert.deepEqual(await patched.json(), { error: "unknown_role", roleId: "still-missing" });
	}
});

test("deleting a resource or role removes catalog_sync_roles rows", async () => {
	const admin = await login(base);
	const role = (await (await fetch(`${base}/api/auth/roles`, json("POST", { name: "Cleanup role", permissions: ["activity.read"] }, admin))).json()).role;

	const created = [];
	for (const spec of DOMAINS) {
		const res = await fetch(`${base}${spec.path}`, json("POST", { ...spec.createBody, name: `${spec.createBody.name} cleanup`, syncRoleIds: [role.id] }, admin));
		assert.equal(res.status, 201);
		created.push({ spec, item: (await res.json())[spec.itemKey] });
	}

	const [first, ...kept] = created;
	assert.equal((await fetch(`${base}${first.spec.path}/${first.item.id}`, { method: "DELETE", headers: { cookie: admin } })).status, 200);
	assert.equal(countSyncRoleRows({ domain: first.spec.tableDomain, resourceId: first.item.id }), 0);
	assert.equal(countSyncRoleRows({ roleId: role.id }), kept.length);

	assert.equal((await fetch(`${base}/api/auth/roles/${role.id}`, { method: "DELETE", headers: { cookie: admin } })).status, 204);
	assert.equal(countSyncRoleRows({ roleId: role.id }), 0);
	for (const { spec, item } of kept) {
		const got = await (await fetch(`${base}${spec.path}/${item.id}`, { headers: { cookie: admin } })).json();
		assert.deepEqual(got[spec.itemKey].syncRoleIds, []);
	}
});

test("catalog export bundles omit syncRoleIds and import starts empty", async () => {
	const admin = await login(base);
	const role = (await (await fetch(`${base}/api/auth/roles`, json("POST", { name: "Export role", permissions: ["activity.read"] }, admin))).json()).role;
	const created = {};
	for (const spec of DOMAINS) {
		const res = await fetch(`${base}${spec.path}`, json("POST", { ...spec.createBody, name: `${spec.createBody.name} export`, syncRoleIds: [role.id] }, admin));
		created[spec.itemKey] = (await res.json())[spec.itemKey];
	}

	for (const spec of DOMAINS) {
		const listExport = await fetch(`${base}${spec.path}/export`, { headers: { cookie: admin } });
		assert.equal(listExport.status, 200);
		const listBundle = await listExport.json();
		assertNoSyncRoleIds(listBundle);

		const itemExport = await fetch(`${base}${spec.path}/${created[spec.itemKey].id}/export`, { headers: { cookie: admin } });
		assert.equal(itemExport.status, 200);
		const itemBundle = await itemExport.json();
		assertNoSyncRoleIds(itemBundle);

		const imported = await fetch(`${base}${spec.path}/import`, json("POST", itemBundle, admin));
		assert.equal(imported.status, 201);
		const items = (await imported.json())[spec.listKey];
		assert.equal(items.length, 1);
		assert.deepEqual(items[0].syncRoleIds, []);
		assert.notEqual(items[0].id, created[spec.itemKey].id);
	}

	const sneaky = await fetch(
		`${base}/api/templates/import`,
		json("POST", { name: "Sneaky import", syncRoleIds: [role.id] }, admin),
	);
	assert.equal(sneaky.status, 201);
	assert.deepEqual((await sneaky.json()).templates[0].syncRoleIds, []);
});

test("GET /api/catalog/sync-roles is 200 for any catalog edit permission and 403 otherwise", async () => {
	assert.equal((await fetch(`${base}/api/catalog/sync-roles`)).status, 401);
	const admin = await login(base);
	const adminList = await fetch(`${base}/api/catalog/sync-roles`, { headers: { cookie: admin } });
	assert.equal(adminList.status, 200);
	const adminBody = await adminList.json();
	assert.ok(Array.isArray(adminBody.roles));
	assert.ok(adminBody.roles.some((role) => role.id === db.ADMIN_ROLE_ID && role.name));
	for (const role of adminBody.roles) {
		assert.equal(typeof role.id, "string");
		assert.equal(typeof role.name, "string");
		assert.equal(Object.keys(role).sort().join(","), "id,name");
	}

	const viewer = await inviteSession(admin, {
		email: "sync-roles-viewer@example.com",
		permissions: ["activity.read"],
		password: "sync-roles-viewer-12",
	});
	const denied = await fetch(`${base}/api/catalog/sync-roles`, { headers: { cookie: viewer.cookie } });
	assert.equal(denied.status, 403);
	assert.deepEqual(await denied.json(), { error: "forbidden", permission: "templates.edit" });

	for (const [email, permissions] of [
		["sync-roles-templates@example.com", ["templates.edit"]],
		["sync-roles-tcp@example.com", ["tcp-tools.edit"]],
		["sync-roles-rci@example.com", ["rci.edit"]],
	]) {
		const session = await inviteSession(admin, { email, permissions, password: "sync-roles-edit-12" });
		const allowed = await fetch(`${base}/api/catalog/sync-roles`, { headers: { cookie: session.cookie } });
		assert.equal(allowed.status, 200, email);
		const body = await allowed.json();
		assert.ok(body.roles.some((role) => role.id === db.ADMIN_ROLE_ID));
	}
});

test("listSyncableCatalog follows permission plus allowlist, with admin bypass and empty-list deny", () => {
	const listed = db.createRole({ name: "Listed syncer", permissions: ["client.templates.sync", "client.tcp-tools.sync", "client.rci.sync"] });
	const unlisted = db.createRole({ name: "Unlisted syncer", permissions: ["client.templates.sync", "client.tcp-tools.sync", "client.rci.sync"] });
	const noPerm = db.createRole({ name: "No sync perm", permissions: ["activity.read"] });
	const listedUser = db.createAuthUser({ email: "listed-sync@example.test", roleId: listed.id });
	const unlistedUser = db.createAuthUser({ email: "unlisted-sync@example.test", roleId: unlisted.id });
	const noPermUser = db.createAuthUser({ email: "nosync@example.test", roleId: noPerm.id });
	const adminUser = db.getAuthUserByEmail(DEFAULT_ADMIN_EMAIL);

	const listedTemplate = db.createTemplate({ name: "Listed template", syncRoleIds: [listed.id] });
	const emptyTemplate = db.createTemplate({ name: "Empty template", syncRoleIds: [] });
	const listedTcp = db.createTcp({
		name: "Listed tcp",
		tools: [{ name: "echo", requestTemplate: "echo" }],
		syncRoleIds: [listed.id],
	});
	const emptyTcp = db.createTcp({ name: "Empty tcp", tools: [{ name: "echo", requestTemplate: "echo" }], syncRoleIds: [] });
	const listedRci = db.createResourceSet({ name: "Listed rci", syncRoleIds: [listed.id] });
	const emptyRci = db.createResourceSet({ name: "Empty rci", syncRoleIds: [] });

	const none = db.listSyncableCatalog(noPermUser.id);
	assert.deepEqual(none, { templates: [], tcps: [], resourceSets: [] });

	const unlistedResult = db.listSyncableCatalog(unlistedUser.id);
	assert.deepEqual(unlistedResult, { templates: [], tcps: [], resourceSets: [] });

	const listedResult = db.listSyncableCatalog(listedUser.id);
	assert.deepEqual(listedResult.templates.map((item) => item.id), [listedTemplate.id]);
	assert.deepEqual(listedResult.tcps.map((item) => item.id), [listedTcp.id]);
	assert.deepEqual(listedResult.resourceSets.map((item) => item.id), [listedRci.id]);

	const adminResult = db.listSyncableCatalog(adminUser.id);
	const adminTemplateIds = adminResult.templates.map((item) => item.id);
	assert.ok(adminTemplateIds.includes(listedTemplate.id));
	assert.ok(adminTemplateIds.includes(emptyTemplate.id));
	assert.ok(adminResult.tcps.some((item) => item.id === listedTcp.id));
	assert.ok(adminResult.tcps.some((item) => item.id === emptyTcp.id));
	assert.ok(adminResult.resourceSets.some((item) => item.id === listedRci.id));
	assert.ok(adminResult.resourceSets.some((item) => item.id === emptyRci.id));

	assert.equal(db.listSyncableCatalog("missing-owner").templates.length, 0);
});
