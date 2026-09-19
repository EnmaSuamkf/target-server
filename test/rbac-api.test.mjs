import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { once } from "node:events";
import { login } from "./helpers.mjs";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-rbac-api-")), "t.db");
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

test("RBAC endpoints deny insufficient permissions and revoke sessions on role changes", async () => {
	const admin = await login(base);
	const createdRole = await fetch(
		`${base}/api/auth/roles`,
		json("POST", { name: "Activity viewer", permissions: ["activity.read"] }, admin),
	);
	assert.equal(createdRole.status, 201);
	const role = (await createdRole.json()).role;

	const invalidInvite = await fetch(
		`${base}/api/auth/users`,
		json("POST", { email: "bad-role@example.com", role_id: "does-not-exist" }, admin),
	);
	assert.equal(invalidInvite.status, 422);

	const inviteResponse = await fetch(
		`${base}/api/auth/users`,
		json("POST", { email: "viewer@example.com", role_id: role.id }, admin),
	);
	assert.equal(inviteResponse.status, 201);
	const invite = await inviteResponse.json();
	assert.equal(invite.user.role, role.id);
	const token = new URL(invite.invite.setupUrl).searchParams.get("token");
	const setup = await fetch(
		`${base}/api/auth/setup`,
		json("POST", { token, password: "viewer-password-12" }),
	);
	assert.equal(setup.status, 200);
	const viewer = setup.headers.get("set-cookie")?.split(";")[0];
	assert.ok(viewer);

	const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: viewer } });
	assert.deepEqual((await me.json()).user.permissions, ["activity.read"]);
	assert.equal((await fetch(`${base}/api/stats`, { headers: { cookie: viewer } })).status, 200);
	assert.equal((await fetch(`${base}/api/auth/users`, { headers: { cookie: viewer } })).status, 403);
	assert.equal((await fetch(`${base}/api/auth/roles`, { headers: { cookie: viewer } })).status, 403);
	assert.equal(
		(await fetch(`${base}/api/auth/roles`, json("POST", { name: "Escalated", permissions: ["users.manage"] }, viewer))).status,
		403,
	);
	assert.equal(
		(await fetch(`${base}/api/sync/remote-workflows/not-real/commands`, json("POST", { type: "workflow.start" }, viewer))).status,
		403,
	);

	const changed = await fetch(
		`${base}/api/auth/roles/${role.id}`,
		json("PATCH", { name: "Activity viewer", permissions: ["activity.read", "remote.read"] }, admin),
	);
	assert.equal(changed.status, 200);
	assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: viewer } })).status, 401);

	const refreshedLogin = await fetch(
		`${base}/api/auth/login`,
		json("POST", { email: "viewer@example.com", password: "viewer-password-12" }),
	);
	const refreshedViewer = refreshedLogin.headers.get("set-cookie")?.split(";")[0];
	assert.equal(refreshedLogin.status, 200);
	assert.equal((await fetch(`${base}/api/sync/clients`, { headers: { cookie: refreshedViewer } })).status, 200);

	const replacementRole = await fetch(
		`${base}/api/auth/roles`,
		json("POST", { name: "No access", permissions: [] }, admin),
	);
	const noAccessRole = (await replacementRole.json()).role;
	assert.equal(
		(await fetch(`${base}/api/auth/users/${invite.user.id}`, json("PATCH", { role_id: noAccessRole.id }, admin))).status,
		200,
	);
	assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: refreshedViewer } })).status, 401);

	const adminMe = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: admin } })).json();
	assert.equal(
		(await fetch(`${base}/api/auth/users/${adminMe.user.id}`, json("PATCH", { role_id: role.id }, admin))).status,
		409,
	);
	assert.equal((await fetch(`${base}/api/auth/users/${adminMe.user.id}`, { method: "DELETE", headers: { cookie: admin } })).status, 409);
});
