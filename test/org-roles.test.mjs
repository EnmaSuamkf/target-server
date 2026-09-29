import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-org-roles-"));
const defaultDb = path.join(tmpDir, "default.db");
const orgAPath = path.join(tmpDir, "org-a.db");
const orgBPath = path.join(tmpDir, "org-b.db");

process.env.TARGET_SERVER_DB = defaultDb;
process.env.TARGET_CONTROL_DB = path.join(tmpDir, "control.db");

const db = await import("../db.mjs");
const control = await import("../control-plane.mjs");

db.open(defaultDb);
control.createOrganization({ id: "org_a", slug: "alpha-roles", name: "Alpha", dbPath: orgAPath });
control.createOrganization({ id: "org_b", slug: "beta-roles", name: "Beta", dbPath: orgBPath });
db.runWithOrg("org_a", () => db.open());
db.runWithOrg("org_b", () => db.open());

test("last-administrator guards act per organization", () => {
	const a1 = db.runWithOrg("org_a", () => db.createAuthUser({ email: "admin-a@org-a.example.com" }));
	const b1 = db.runWithOrg("org_b", () => db.createAuthUser({ email: "admin-b@org-b.example.com" }));
	const opA = db.runWithOrg("org_a", () => db.createRole({ name: "Operator A", permissions: ["activity.read"] }));
	const opB = db.runWithOrg("org_b", () => db.createRole({ name: "Operator B", permissions: ["activity.read"] }));

	assert.throws(
		() => db.runWithOrg("org_a", () => db.reassignAuthUserRole({ userId: a1.id, roleId: opA.id })),
		(error) => error.code === "last_administrator",
	);
	assert.throws(
		() => db.runWithOrg("org_a", () => db.deleteAuthUser(a1.id)),
		(error) => error.code === "last_administrator",
	);

	const b2 = db.runWithOrg("org_b", () => db.createAuthUser({ email: "admin-b2@org-b.example.com" }));
	const moved = db.runWithOrg("org_b", () => db.reassignAuthUserRole({ userId: b1.id, roleId: opB.id }));
	assert.equal(moved.role, opB.id);
	assert.equal(db.runWithOrg("org_b", () => db.deleteAuthUser(b1.id)), true);
	assert.ok(db.runWithOrg("org_b", () => db.getAuthUserById(b2.id)));

	assert.throws(
		() => db.runWithOrg("org_a", () => db.deleteAuthUser(a1.id)),
		(error) => error.code === "last_administrator",
	);
	assert.equal(db.runWithOrg("org_a", () => db.getAuthUserById(a1.id)).role, db.ADMIN_ROLE_ID);
	assert.equal(db.runWithOrg("org_b", () => db.getAuthUserById(b1.id)), null);
});

test("user whose role is deleted from the DB has zero permissions after re-open", () => {
	const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-orphan-role-")), "t.db");
	const controlDb = `${dbPath}-control`;
	const setup = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
				process.env.TARGET_SERVER_DB = ${JSON.stringify(dbPath)};
				process.env.TARGET_CONTROL_DB = ${JSON.stringify(controlDb)};
				const db = await import("./db.mjs");
				db.open(${JSON.stringify(dbPath)});
				const role = db.createRole({ name: "Temp", permissions: ["activity.read"] });
				const user = db.createAuthUser({ email: "orphan@example.com", roleId: role.id });
				db.open().prepare("DELETE FROM auth_role_permissions WHERE role_id = ?").run(role.id);
				db.open().prepare("DELETE FROM auth_roles WHERE id = ?").run(role.id);
				console.log("ORPHAN_SETUP:" + JSON.stringify({ id: user.id, role: user.role }));
			`,
		],
		{ cwd: ROOT, encoding: "utf8", timeout: 20000, env: { ...process.env, TARGET_SERVER_DB: dbPath, TARGET_CONTROL_DB: controlDb } },
	);
	assert.equal(setup.status, 0, setup.stderr || setup.stdout);
	const setupLine = setup.stdout.split("\n").find((line) => line.startsWith("ORPHAN_SETUP:"));
	assert.ok(setupLine, setup.stdout);
	const created = JSON.parse(setupLine.slice("ORPHAN_SETUP:".length));

	const reopen = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
				process.env.TARGET_SERVER_DB = ${JSON.stringify(dbPath)};
				process.env.TARGET_CONTROL_DB = ${JSON.stringify(controlDb)};
				const db = await import("./db.mjs");
				db.open(${JSON.stringify(dbPath)});
				const user = db.getAuthUserById(${JSON.stringify(created.id)});
				console.log("ORPHAN_REOPEN:" + JSON.stringify({
					role: user.role,
					permissions: db.getAuthUserPermissions(user),
					admin: db.ADMIN_ROLE_ID,
				}));
			`,
		],
		{ cwd: ROOT, encoding: "utf8", timeout: 20000, env: { ...process.env, TARGET_SERVER_DB: dbPath, TARGET_CONTROL_DB: controlDb } },
	);
	assert.equal(reopen.status, 0, reopen.stderr || reopen.stdout);
	const reopenLine = reopen.stdout.split("\n").find((line) => line.startsWith("ORPHAN_REOPEN:"));
	assert.ok(reopenLine, reopen.stdout);
	const after = JSON.parse(reopenLine.slice("ORPHAN_REOPEN:".length));
	assert.notEqual(after.role, after.admin);
	assert.equal(after.role, db.NONE_ROLE_ID);
	assert.deepEqual(after.permissions, []);
});
