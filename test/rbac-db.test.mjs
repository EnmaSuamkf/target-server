import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-rbac-")), "legacy.db");
const legacy = new DatabaseSync(dbPath);
legacy.exec(`
	CREATE TABLE auth_users (
		id TEXT PRIMARY KEY,
		email TEXT NOT NULL UNIQUE,
		password_hash TEXT,
		role TEXT NOT NULL DEFAULT 'admin',
		token_version INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL,
		created_by TEXT,
		invited_at TEXT,
		activated_at TEXT,
		last_login_at TEXT
	);
`);
legacy
	.prepare(
		`INSERT INTO auth_users (id, email, role, token_version, created_at)
		 VALUES ('legacy-admin', 'legacy@example.test', 'admin', 1, '2026-01-01T00:00:00.000Z')`,
	)
	.run();
legacy.close();

process.env.TARGET_SERVER_DB = dbPath;
const rbac = await import("../db.mjs");
rbac.open();

test("additive migration preserves legacy users and gives admin every catalogued permission", () => {
	const user = rbac.getAuthUserById("legacy-admin");
	assert.equal(user.email, "legacy@example.test");
	assert.equal(user.role, rbac.ADMIN_ROLE_ID);

	const admin = rbac.getRoleById(rbac.ADMIN_ROLE_ID);
	assert.equal(admin.isSystem, true);
	assert.deepEqual(admin.permissions, [...rbac.PERMISSIONS].sort());
	assert.equal(rbac.countUsersByRole(rbac.ADMIN_ROLE_ID), 1);
});

test("role functions reject unknown permissions and protect the system admin role", () => {
	assert.ok(rbac.PERMISSIONS.every((permission) => rbac.isValidPermission(permission)));
	assert.equal(rbac.isValidPermission("role.escalate"), false);
	assert.throws(
		() => rbac.createRole({ name: "Bad", permissions: ["anything.goes"] }),
		(error) => error.code === "invalid_permission",
	);
	assert.throws(
		() => rbac.updateRole(rbac.ADMIN_ROLE_ID, { name: "Changed", permissions: [] }),
		(error) => error.code === "system_role_protected",
	);
	assert.throws(
		() => rbac.deleteRole(rbac.ADMIN_ROLE_ID),
		(error) => error.code === "system_role_protected",
	);
});

test("custom roles support create, edit and deletion when unassigned", () => {
	const role = rbac.createRole({ name: "Temporary", permissions: ["activity.read"] });
	const changed = rbac.updateRole(role.id, { name: "Temporary editor", permissions: ["remote.read"] });
	assert.deepEqual(changed.permissions, ["remote.read"]);
	assert.equal(rbac.deleteRole(role.id), true);
	assert.equal(rbac.getRoleById(role.id), null);
});

test("assigned roles cannot be deleted and the last administrator cannot be lost", () => {
	const operator = rbac.createRole({
		name: "Operator",
		permissions: ["activity.read", "remote.read", "remote.workflows.execute"],
		actorUserId: "legacy-admin",
	});
	const secondAdmin = rbac.createAuthUser({ email: "second-admin@example.test" });
	const moved = rbac.reassignAuthUserRole({
		userId: "legacy-admin",
		roleId: operator.id,
		actorUserId: secondAdmin.id,
	});
	assert.equal(moved.role, operator.id);
	assert.equal(moved.tokenVersion, 2);
	assert.equal(rbac.countUsersByRole(operator.id), 1);
	rbac.updateRole(operator.id, {
		name: "Operator",
		permissions: ["activity.read", "remote.read"],
		actorUserId: secondAdmin.id,
	});
	assert.equal(rbac.getAuthUserById("legacy-admin").tokenVersion, 3);
	assert.throws(() => rbac.deleteRole(operator.id), (error) => error.code === "role_assigned");
	assert.throws(
		() => rbac.reassignAuthUserRole({ userId: secondAdmin.id, roleId: operator.id }),
		(error) => error.code === "last_administrator",
	);
	// There is still a non-admin user (`legacy-admin`), so this proves the
	// invariant is "last administrator", not merely "last user".
	assert.throws(
		() => rbac.deleteAuthUser(secondAdmin.id),
		(error) => error.code === "last_administrator",
	);
	assert.throws(
		() => rbac.reassignAuthUserRole({ userId: "legacy-admin", roleId: "missing-role" }),
		(error) => error.code === "role_not_found",
	);
	assert.ok(rbac.listRoleAudit({ roleId: operator.id }).some((entry) => entry.action === "user.role_reassigned"));
});
