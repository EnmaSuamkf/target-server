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
	CREATE TABLE auth_roles (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		is_system INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE auth_role_permissions (
		role_id TEXT NOT NULL,
		permission TEXT NOT NULL CHECK (permission IN (
			'activity.read',
			'users.read',
			'users.manage',
			'remote.read',
			'remote.workflows.manage',
			'remote.workflows.execute',
			'remote.templates.manage',
			'remote.tcp-tools.manage',
			'remote.rci.manage',
			'remote.workflows.create',
			'remote.templates.create',
			'devices.link',
			'devices.manage'
		)),
		PRIMARY KEY (role_id, permission)
	);
`);
legacy
	.prepare(
		`INSERT INTO auth_users (id, email, role, token_version, created_at)
		 VALUES ('legacy-admin', 'legacy@example.test', 'admin', 1, '2026-01-01T00:00:00.000Z')`,
	)
	.run();
legacy
	.prepare(
		`INSERT INTO auth_roles (id, name, is_system, created_at, updated_at)
		 VALUES ('legacy-operator', 'Legacy Operator', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	)
	.run();
for (const permission of [
	"remote.read",
	"remote.workflows.manage",
	"remote.workflows.execute",
	"remote.templates.manage",
	"remote.tcp-tools.manage",
	"remote.rci.manage",
]) {
	legacy.prepare("INSERT INTO auth_role_permissions (role_id, permission) VALUES (?, ?)").run("legacy-operator", permission);
}
legacy
	.prepare(
		`INSERT INTO auth_roles (id, name, is_system, created_at, updated_at)
		 VALUES ('legacy-creator', 'Legacy Creator', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	)
	.run();
// Pre-rename live `remote.*` IDs are remapped one-to-one onto `client.*`.
for (const permission of ["remote.read", "remote.workflows.create", "remote.templates.create"]) {
	legacy.prepare("INSERT INTO auth_role_permissions (role_id, permission) VALUES (?, ?)").run("legacy-creator", permission);
}
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

test("opening a pre-granular DB remaps old resource manage rows and grants workflow children", () => {
	const operator = rbac.getRoleById("legacy-operator");
	assert.ok(operator);
	for (const removed of ["remote.templates.manage", "remote.tcp-tools.manage", "remote.rci.manage"]) {
		assert.equal(operator.permissions.includes(removed), false);
		assert.equal(rbac.isValidPermission(removed), false);
	}
	for (const granted of [
		"client.read",
		"client.workflows.manage",
		"client.workflows.execute",
		"client.workflows.create",
		"client.workflows.steps.add",
		"client.workflows.steps.edit",
		"client.templates.create",
		"client.templates.edit",
		"client.templates.delete",
		"client.templates.import",
		"client.templates.export",
		"client.tcp-tools.create",
		"client.tcp-tools.edit",
		"client.tcp-tools.delete",
		"client.tcp-tools.import",
		"client.tcp-tools.export",
		"client.rci.create",
		"client.rci.edit",
		"client.rci.delete",
		"client.rci.import",
		"client.rci.export",
	]) {
		assert.ok(operator.permissions.includes(granted), `missing ${granted}`);
	}

	const sql = rbac.open().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auth_role_permissions'").get().sql;
	assert.ok(rbac.PERMISSIONS.every((permission) => sql.includes(`'${permission}'`)));
	assert.ok(!sql.includes("'remote.templates.manage'"));
	rbac.open().prepare("INSERT OR IGNORE INTO auth_role_permissions (role_id, permission) VALUES (?, ?)").run(
		"legacy-operator",
		"client.templates.create",
	);
	assert.throws(
		() => rbac.open().prepare("INSERT INTO auth_role_permissions (role_id, permission) VALUES (?, ?)").run("legacy-operator", "role.escalate"),
		(error) => /CHECK|constraint/i.test(String(error.message)),
	);
});

test("opening a pre-rename DB remaps live remote.* rows onto client.*", () => {
	const creator = rbac.getRoleById("legacy-creator");
	assert.deepEqual(creator.permissions, ["client.read", "client.templates.create", "client.workflows.create"]);
	const leftover = rbac
		.open()
		.prepare("SELECT COUNT(*) AS n FROM auth_role_permissions WHERE permission LIKE 'remote.%'")
		.get().n;
	assert.equal(leftover, 0);
	const sql = rbac.open().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auth_role_permissions'").get().sql;
	assert.ok(!sql.includes("'remote.workflows.create'"));
	assert.ok(!sql.includes("'remote.read'"));
	for (const renamed of ["remote.read", "remote.workflows.create", "remote.workflows.manage"]) {
		assert.equal(rbac.isValidPermission(renamed), false);
	}
	assert.deepEqual(rbac.expandStoredPermission("remote.workflows.create"), ["client.workflows.create"]);
	assert.deepEqual(rbac.expandStoredPermission("remote.templates.manage"), [
		"client.templates.create",
		"client.templates.edit",
		"client.templates.delete",
		"client.templates.import",
		"client.templates.export",
	]);
	assert.deepEqual(rbac.expandStoredPermission("remote.unknown"), []);
});

test("role functions reject unknown permissions and protect the system admin role", () => {
	assert.ok(rbac.PERMISSIONS.every((permission) => rbac.isValidPermission(permission)));
	assert.equal(rbac.isValidPermission("role.escalate"), false);
	assert.equal(rbac.isValidPermission("remote.templates.manage"), false);
	assert.throws(
		() => rbac.createRole({ name: "Bad", permissions: ["anything.goes"] }),
		(error) => error.code === "invalid_permission",
	);
	assert.throws(
		() => rbac.createRole({ name: "Legacy manage", permissions: ["remote.tcp-tools.manage"] }),
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
	const changed = rbac.updateRole(role.id, { name: "Temporary editor", permissions: ["client.read"] });
	assert.deepEqual(changed.permissions, ["client.read"]);
	assert.equal(rbac.deleteRole(role.id), true);
	assert.equal(rbac.getRoleById(role.id), null);
});

test("assigned roles cannot be deleted and the last administrator cannot be lost", () => {
	const operator = rbac.createRole({
		name: "Operator",
		permissions: ["activity.read", "client.read", "client.workflows.execute"],
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
		permissions: ["activity.read", "client.read"],
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
