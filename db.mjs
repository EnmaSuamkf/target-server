/**
 * Storage for the Target report server (node:sqlite, zero external deps — same
 * approach as the Target hub itself).
 *
 * Two tables:
 *  - `instances`: one row per reporting Target instance (identity + version +
 *    first/last seen), upserted on every batch.
 *  - `events`: one row per activity event. `id` is the event's own uuid and the
 *    PRIMARY KEY, so `INSERT OR IGNORE` gives us idempotent ingest for free — a
 *    re-sent batch (same ids) inserts nothing new but is still acknowledged, per
 *    the contract in docs/report-server.es.html §7.4.
 */
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { validateCommand } from "./blueprint.mjs";

let db = null;

export const DEFAULT_ADMIN_EMAIL = "admin@admin.com";
export const DEFAULT_ADMIN_PASSWORD = "password-target-server";

/**
 * The complete RBAC vocabulary. This is the single application catalogue:
 * checks and role writes must use these IDs rather than client-supplied
 * capability strings.
 */
export const PERMISSION_CATALOG = Object.freeze([
	{ id: "activity.read", description: "View Activity and reporting data" },
	{ id: "users.read", description: "View users, roles and invitations" },
	{ id: "users.manage", description: "Manage users, roles and invitations" },
	{ id: "remote.read", description: "View Remote Control clients and state" },
	{ id: "remote.workflows.manage", description: "Create and modify remote workflows" },
	{ id: "remote.workflows.execute", description: "Start, pause, resume and restart remote workflows" },
	{ id: "remote.templates.manage", description: "Manage remote workflow templates" },
	{ id: "remote.tcp-tools.manage", description: "Manage remote TCP tools" },
	{ id: "remote.rci.manage", description: "Manage remote RCI resources" },
]);
export const PERMISSIONS = Object.freeze(PERMISSION_CATALOG.map(({ id }) => id));
export const ADMIN_ROLE_ID = "admin";
const PERMISSION_SET = new Set(PERMISSIONS);

export function open(dbPath = process.env.TARGET_SERVER_DB ?? "./target-server.db") {
	if (db) return db;
	db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS instances (
			instance_id   TEXT PRIMARY KEY,
			display_name  TEXT,
			version       TEXT,
			first_seen_at TEXT NOT NULL,
			last_seen_at  TEXT NOT NULL,
			events_count  INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS events (
			id           TEXT PRIMARY KEY,
			instance_id  TEXT NOT NULL,
			kind         TEXT NOT NULL,
			workflow_id  TEXT,
			session_id   TEXT,
			version      TEXT,
			created_at   TEXT,
			received_at  TEXT NOT NULL,
			data         TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
		CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
		CREATE INDEX IF NOT EXISTS idx_events_instance ON events(instance_id);
		CREATE INDEX IF NOT EXISTS idx_events_workflow ON events(workflow_id);
		CREATE TABLE IF NOT EXISTS auth_users (
			id             TEXT PRIMARY KEY,
			email          TEXT NOT NULL UNIQUE,
			password_hash  TEXT,
			role           TEXT NOT NULL DEFAULT 'admin',
			token_version  INTEGER NOT NULL DEFAULT 1,
			created_at     TEXT NOT NULL,
			created_by     TEXT,
			invited_at     TEXT,
			activated_at   TEXT,
			last_login_at  TEXT
		);
		CREATE TABLE IF NOT EXISTS auth_resets (
			token_hash  TEXT PRIMARY KEY,
			user_id     TEXT NOT NULL,
			kind        TEXT NOT NULL DEFAULT 'reset',
			created_at  TEXT NOT NULL,
			expires_at  TEXT NOT NULL,
			used_at     TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_resets_user ON auth_resets(user_id);
		CREATE TABLE IF NOT EXISTS auth_meta (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			jwt_secret TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS clients (
			id                 TEXT PRIMARY KEY,
			name               TEXT,
			token_hash         TEXT NOT NULL,
			status             TEXT NOT NULL DEFAULT 'active',
			capabilities_json  TEXT,
			last_seen_at       TEXT,
			created_at         TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS remote_workflows (
			id                   TEXT PRIMARY KEY,
			client_id            TEXT NOT NULL,
			name                 TEXT,
			status               TEXT,
			local_id             TEXT,
			conversation_context TEXT,
			sandbox              TEXT NOT NULL DEFAULT 'docker',
			created_at           TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS remote_workflow_steps (
			id                     TEXT PRIMARY KEY,
			remote_id              TEXT NOT NULL,
			step_key               TEXT NOT NULL,
			order_index            INTEGER NOT NULL,
			description            TEXT NOT NULL,
			acceptance_criteria    TEXT,
			manual_review          INTEGER NOT NULL DEFAULT 0,
			use_subagent           INTEGER NOT NULL DEFAULT 1,
			max_retries            INTEGER NOT NULL DEFAULT 0,
			retry_interval_seconds INTEGER NOT NULL DEFAULT 0,
			status                 TEXT NOT NULL DEFAULT 'pending',
			on_client              INTEGER NOT NULL DEFAULT 0,
			UNIQUE(remote_id, step_key)
		);
		CREATE INDEX IF NOT EXISTS idx_remote_workflow_steps_remote ON remote_workflow_steps(remote_id);
		CREATE TABLE IF NOT EXISTS commands (
			id            TEXT PRIMARY KEY,
			client_id     TEXT NOT NULL,
			remote_id     TEXT,
			type          TEXT NOT NULL,
			payload_json  TEXT NOT NULL,
			sequence      INTEGER NOT NULL,
			status        TEXT NOT NULL DEFAULT 'pending',
			created_at    TEXT NOT NULL,
			acked_at      TEXT
		);
		CREATE TABLE IF NOT EXISTS sync_events (
			id            TEXT PRIMARY KEY,
			client_id     TEXT NOT NULL,
			remote_id     TEXT,
			type          TEXT NOT NULL,
			payload_json  TEXT NOT NULL,
			received_at   TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS remote_resources (
			client_id     TEXT NOT NULL,
			domain        TEXT NOT NULL CHECK (domain IN ('templates', 'tcp_tools', 'resource_sets')),
			resource_id   TEXT NOT NULL,
			name          TEXT NOT NULL,
			resource_json TEXT NOT NULL,
			revision      INTEGER NOT NULL DEFAULT 1,
			updated_at    TEXT NOT NULL,
			PRIMARY KEY (client_id, domain, resource_id)
		);
		CREATE INDEX IF NOT EXISTS idx_commands_client_status ON commands(client_id, status);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_remote_sequence ON commands(remote_id, sequence);
		CREATE INDEX IF NOT EXISTS idx_remote_workflows_client ON remote_workflows(client_id);
		CREATE INDEX IF NOT EXISTS idx_sync_events_client ON sync_events(client_id, received_at);
		CREATE INDEX IF NOT EXISTS idx_remote_resources_client_domain ON remote_resources(client_id, domain);
	`);
	migrateSyncSchema(db);
	migrateAuthSchema(db);
	migrateRbacSchema(db);
	seedAuth();
	return db;
}

/** Additive migrations for existing target-server.db files. */
function migrateSyncSchema(database) {
	const addColumn = (table, name, ddl) => {
		try {
			database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
		} catch {
			// Column already exists.
		}
	};
	addColumn("remote_workflows", "conversation_context", "TEXT");
	addColumn("remote_workflows", "sandbox", "TEXT NOT NULL DEFAULT 'docker'");
	addColumn("remote_workflows", "agent", "TEXT");
	addColumn("remote_workflow_steps", "on_client", "INTEGER NOT NULL DEFAULT 0");
	addColumn("remote_workflow_steps", "run_selected", "INTEGER NOT NULL DEFAULT 1");
	database.exec(`
		CREATE TABLE IF NOT EXISTS remote_resources (
			client_id     TEXT NOT NULL,
			domain        TEXT NOT NULL CHECK (domain IN ('templates', 'tcp_tools', 'resource_sets')),
			resource_id   TEXT NOT NULL,
			name          TEXT NOT NULL,
			resource_json TEXT NOT NULL,
			revision      INTEGER NOT NULL DEFAULT 1,
			updated_at    TEXT NOT NULL,
			PRIMARY KEY (client_id, domain, resource_id)
		);
		CREATE INDEX IF NOT EXISTS idx_remote_resources_client_domain ON remote_resources(client_id, domain);
		CREATE TABLE IF NOT EXISTS remote_workflow_steps (
			id                     TEXT PRIMARY KEY,
			remote_id              TEXT NOT NULL,
			step_key               TEXT NOT NULL,
			order_index            INTEGER NOT NULL,
			description            TEXT NOT NULL,
			acceptance_criteria    TEXT,
			manual_review          INTEGER NOT NULL DEFAULT 0,
			use_subagent           INTEGER NOT NULL DEFAULT 1,
			max_retries            INTEGER NOT NULL DEFAULT 0,
			retry_interval_seconds INTEGER NOT NULL DEFAULT 0,
			status                 TEXT NOT NULL DEFAULT 'pending',
			on_client              INTEGER NOT NULL DEFAULT 0,
			UNIQUE(remote_id, step_key)
		);
		CREATE INDEX IF NOT EXISTS idx_remote_workflow_steps_remote ON remote_workflow_steps(remote_id);
	`);
}

function migrateAuthSchema(database) {
	const addColumn = (table, name, ddl) => {
		try {
			database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
		} catch {
			// Column already exists.
		}
	};
	addColumn("auth_users", "google_sub", "TEXT");
	database.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_google_sub
		ON auth_users(google_sub) WHERE google_sub IS NOT NULL;
	`);
	addColumn("auth_users", "invite_allow_password", "INTEGER NOT NULL DEFAULT 1");
	addColumn("auth_users", "invite_allow_google", "INTEGER NOT NULL DEFAULT 0");
}

/** Additive RBAC migration. `auth_users.role` remains the assignment column. */
function migrateRbacSchema(database) {
	const now = new Date().toISOString();
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec(`
			CREATE TABLE IF NOT EXISTS auth_roles (
				id          TEXT PRIMARY KEY,
				name        TEXT NOT NULL UNIQUE,
				is_system   INTEGER NOT NULL DEFAULT 0,
				created_at  TEXT NOT NULL,
				updated_at  TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS auth_role_permissions (
				role_id     TEXT NOT NULL,
				permission  TEXT NOT NULL CHECK (permission IN (
					'activity.read',
					'users.read',
					'users.manage',
					'remote.read',
					'remote.workflows.manage',
					'remote.workflows.execute',
					'remote.templates.manage',
					'remote.tcp-tools.manage',
					'remote.rci.manage'
				)),
				PRIMARY KEY (role_id, permission)
			);
			CREATE INDEX IF NOT EXISTS idx_auth_role_permissions_role
				ON auth_role_permissions(role_id);
			CREATE INDEX IF NOT EXISTS idx_auth_users_role ON auth_users(role);
			CREATE TABLE IF NOT EXISTS auth_role_audit (
				id              TEXT PRIMARY KEY,
				role_id         TEXT,
				action          TEXT NOT NULL,
				actor_user_id   TEXT,
				subject_user_id TEXT,
				before_json     TEXT,
				after_json      TEXT,
				created_at      TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_auth_role_audit_role
				ON auth_role_audit(role_id, created_at DESC);
		`);
		database
			.prepare(
				`INSERT INTO auth_roles (id, name, is_system, created_at, updated_at)
				 VALUES (?, 'Administrator', 1, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET is_system = 1`,
			)
			.run(ADMIN_ROLE_ID, now, now);
		const insertPermission = database.prepare(
			"INSERT OR IGNORE INTO auth_role_permissions (role_id, permission) VALUES (?, ?)",
		);
		for (const permission of PERMISSIONS) insertPermission.run(ADMIN_ROLE_ID, permission);
		database
			.prepare(
				`DELETE FROM auth_role_permissions
				 WHERE role_id = ? AND permission NOT IN (${PERMISSIONS.map(() => "?").join(",")})`,
			)
			.run(ADMIN_ROLE_ID, ...PERMISSIONS);
		// Earlier databases have only the legacy `role` string. Preserve every
		// user and safely map orphaned/empty assignments to the system admin role.
		database
			.prepare(
				`UPDATE auth_users SET role = ?
				 WHERE role IS NULL OR TRIM(role) = ''
				    OR NOT EXISTS (SELECT 1 FROM auth_roles r WHERE r.id = auth_users.role)`,
			)
			.run(ADMIN_ROLE_ID);
		database.exec("COMMIT");
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

function rbacError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

export function isValidPermission(permission) {
	return typeof permission === "string" && PERMISSION_SET.has(permission);
}

/** Validate and canonicalize a role permission list against the closed catalogue. */
export function validateRolePermissions(permissions) {
	if (!Array.isArray(permissions)) throw rbacError("invalid_permissions", "permissions must be an array");
	const unique = [...new Set(permissions)];
	if (unique.some((permission) => !isValidPermission(permission))) {
		throw rbacError("invalid_permission", "role contains an unknown permission");
	}
	return unique.sort();
}

function roleRowToObject(row, permissions = [], userCount = 0) {
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		isSystem: Boolean(row.is_system),
		permissions,
		userCount,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function getRolePermissions(id) {
	return open()
		.prepare("SELECT permission FROM auth_role_permissions WHERE role_id = ? ORDER BY permission")
		.all(id)
		.map((row) => row.permission);
}

export function getRoleById(id) {
	const row = open().prepare("SELECT * FROM auth_roles WHERE id = ?").get(id);
	return roleRowToObject(row, row ? getRolePermissions(id) : []);
}

/** Resolve authorization from the current DB role, never from a JWT claim. */
export function getAuthUserPermissions(userOrRoleId) {
	const roleId = typeof userOrRoleId === "string" ? userOrRoleId : userOrRoleId?.role;
	return roleId ? getRolePermissions(roleId) : [];
}

export function countAuthUsersByRole(roleId) {
	return open().prepare("SELECT COUNT(*) AS n FROM auth_users WHERE role = ?").get(roleId).n;
}

export const countUsersByRole = countAuthUsersByRole;

export function listRoles() {
	const rows = open()
		.prepare(
			`SELECT r.*, COUNT(u.id) AS user_count
			 FROM auth_roles r LEFT JOIN auth_users u ON u.role = r.id
			 GROUP BY r.id ORDER BY r.is_system DESC, r.name COLLATE NOCASE ASC`,
		)
		.all();
	return rows.map((row) => roleRowToObject(row, getRolePermissions(row.id), row.user_count));
}

function requireRole(id) {
	const role = getRoleById(id);
	if (!role) throw rbacError("role_not_found", "role does not exist");
	return role;
}

function writeRoleAudit({ roleId = null, action, actorUserId = null, subjectUserId = null, before = null, after = null }) {
	open()
		.prepare(
			`INSERT INTO auth_role_audit
			 (id, role_id, action, actor_user_id, subject_user_id, before_json, after_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			randomUUID(),
			roleId,
			action,
			actorUserId,
			subjectUserId,
			before == null ? null : JSON.stringify(before),
			after == null ? null : JSON.stringify(after),
			new Date().toISOString(),
		);
}

export function listRoleAudit({ roleId = null, limit = 100 } = {}) {
	const cappedLimit = Math.max(1, Math.min(500, limit));
	const rows = roleId
		? open()
				.prepare("SELECT * FROM auth_role_audit WHERE role_id = ? ORDER BY created_at DESC LIMIT ?")
				.all(roleId, cappedLimit)
		: open().prepare("SELECT * FROM auth_role_audit ORDER BY created_at DESC LIMIT ?").all(cappedLimit);
	return rows.map((row) => ({
		id: row.id,
		roleId: row.role_id,
		action: row.action,
		actorUserId: row.actor_user_id,
		subjectUserId: row.subject_user_id,
		before: row.before_json ? JSON.parse(row.before_json) : null,
		after: row.after_json ? JSON.parse(row.after_json) : null,
		createdAt: row.created_at,
	}));
}

export function createRole({ name, permissions, actorUserId = null }) {
	if (typeof name !== "string" || !name.trim()) throw rbacError("invalid_role_name", "role name is required");
	const normalizedName = name.trim();
	const validPermissions = validateRolePermissions(permissions);
	const id = randomUUID();
	const now = new Date().toISOString();
	const database = open();
	database.exec("BEGIN IMMEDIATE");
	try {
		database.prepare("INSERT INTO auth_roles (id, name, is_system, created_at, updated_at) VALUES (?, ?, 0, ?, ?)").run(id, normalizedName, now, now);
		const statement = database.prepare("INSERT INTO auth_role_permissions (role_id, permission) VALUES (?, ?)");
		for (const permission of validPermissions) statement.run(id, permission);
		const role = getRoleById(id);
		writeRoleAudit({ roleId: id, action: "role.created", actorUserId, after: role });
		database.exec("COMMIT");
		return role;
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

export function updateRole(id, { name, permissions, actorUserId = null }) {
	const previous = requireRole(id);
	if (previous.isSystem) throw rbacError("system_role_protected", "system roles cannot be edited");
	if (typeof name !== "string" || !name.trim()) throw rbacError("invalid_role_name", "role name is required");
	const validPermissions = validateRolePermissions(permissions);
	const database = open();
	database.exec("BEGIN IMMEDIATE");
	try {
		database.prepare("UPDATE auth_roles SET name = ?, updated_at = ? WHERE id = ?").run(name.trim(), new Date().toISOString(), id);
		database.prepare("DELETE FROM auth_role_permissions WHERE role_id = ?").run(id);
		const statement = database.prepare("INSERT INTO auth_role_permissions (role_id, permission) VALUES (?, ?)");
		for (const permission of validPermissions) statement.run(id, permission);
		// A role's authorization is embedded in existing JWTs only indirectly:
		// invalidate every assignee so their next request must establish a fresh
		// session after a permissions change.
		database.prepare("UPDATE auth_users SET token_version = token_version + 1 WHERE role = ?").run(id);
		const role = getRoleById(id);
		writeRoleAudit({ roleId: id, action: "role.updated", actorUserId, before: previous, after: role });
		database.exec("COMMIT");
		return role;
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

export function deleteRole(id, { actorUserId = null } = {}) {
	const role = requireRole(id);
	if (role.isSystem) throw rbacError("system_role_protected", "system roles cannot be deleted");
	if (countAuthUsersByRole(id) > 0) throw rbacError("role_assigned", "cannot delete a role assigned to users");
	const database = open();
	database.exec("BEGIN IMMEDIATE");
	try {
		database.prepare("DELETE FROM auth_role_permissions WHERE role_id = ?").run(id);
		database.prepare("DELETE FROM auth_roles WHERE id = ?").run(id);
		writeRoleAudit({ roleId: id, action: "role.deleted", actorUserId, before: role });
		database.exec("COMMIT");
		return true;
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

/** Reassign a user and invalidate their active sessions. */
export function reassignAuthUserRole({ userId, roleId, actorUserId = null }) {
	const user = getAuthUserById(userId);
	if (!user) throw rbacError("user_not_found", "user does not exist");
	const role = requireRole(roleId);
	if (user.role === ADMIN_ROLE_ID && roleId !== ADMIN_ROLE_ID && countAuthUsersByRole(ADMIN_ROLE_ID) <= 1) {
		throw rbacError("last_administrator", "cannot remove the last administrator");
	}
	if (user.role === roleId) return user;
	const database = open();
	database.exec("BEGIN IMMEDIATE");
	try {
		database.prepare("UPDATE auth_users SET role = ?, token_version = token_version + 1 WHERE id = ?").run(roleId, userId);
		const updated = getAuthUserById(userId);
		writeRoleAudit({
			roleId,
			action: "user.role_reassigned",
			actorUserId,
			subjectUserId: userId,
			before: { roleId: user.role },
			after: { roleId: role.id },
		});
		database.exec("COMMIT");
		return updated;
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

/** Invite activation flags stored on `auth_users` (for resend / mail / copy link). */
export function getAuthUserInviteMethods(user) {
	if (!user) {
		return { allowPassword: false, allowGoogle: false };
	}
	return {
		allowPassword: Boolean(user.inviteAllowPassword),
		allowGoogle: Boolean(user.inviteAllowGoogle),
	};
}

function rowToAuthUser(r) {
	if (!r) return null;
	return {
		id: r.id,
		email: r.email,
		passwordHash: r.password_hash,
		googleSub: r.google_sub ?? null,
		role: r.role,
		tokenVersion: r.token_version,
		createdAt: r.created_at,
		createdBy: r.created_by,
		invitedAt: r.invited_at,
		activatedAt: r.activated_at,
		lastLoginAt: r.last_login_at,
		inviteAllowPassword: r.invite_allow_password !== 0,
		inviteAllowGoogle: r.invite_allow_google !== 0,
	};
}

function hashPasswordSync(plain) {
	const salt = randomBytes(16);
	const hash = scryptSync(plain, salt, 64, { N: 16384, r: 8, p: 1 });
	return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Origin for emailed setup/reset links (never from the Host header). */
export function publicUrl(opts = {}) {
	const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
	const port = opts.port ?? process.env.PORT ?? "8900";
	const explicit = (process.env.TARGET_PUBLIC_URL ?? "").replace(/\/$/, "");
	const render = (process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
	// Custom domain: a non-onrender TARGET_PUBLIC_URL is authoritative.
	if (explicit && !explicit.includes(".onrender.com")) return explicit;
	// On Render, RENDER_EXTERNAL_URL matches the live service hostname.
	if (render) return render;
	if (explicit) return explicit;
	return `http://${host}:${port}`.replace(/\/$/, "");
}

function publishedDeployUrl() {
	return publicUrl();
}

export function isPublishedRenderDeploy() {
	if (process.env.RENDER === "true") return true;
	const url = publishedDeployUrl();
	return url === "https://target-server-okjn.onrender.com";
}

function resolveSeedPassword() {
	if (isPublishedRenderDeploy()) {
		return DEFAULT_ADMIN_PASSWORD;
	}
	if (process.env.TARGET_USE_PUBLISHED_ADMIN === "1") {
		return DEFAULT_ADMIN_PASSWORD;
	}
	const raw = process.env.TARGET_SEED_ADMIN_PASSWORD;
	if (raw === undefined) return DEFAULT_ADMIN_PASSWORD;
	const trimmed = raw.trim();
	return trimmed || DEFAULT_ADMIN_PASSWORD;
}

function seedAuth() {
	const count = db.prepare("SELECT COUNT(*) AS n FROM auth_users").get().n;
	const seedPassword = resolveSeedPassword();
	if (count > 0) {
		syncAdminSeedPassword(seedPassword);
		return;
	}
	const now = new Date().toISOString();
	const id = randomUUID();
	const hash = hashPasswordSync(seedPassword);
	db.prepare(
		`INSERT INTO auth_users (id, email, password_hash, role, token_version, created_at, activated_at)
		 VALUES (?, ?, ?, 'admin', 1, ?, ?)`,
	).run(id, DEFAULT_ADMIN_EMAIL, hash, now, now);
	if (seedPassword === DEFAULT_ADMIN_PASSWORD) {
		console.warn("[target-server] WARNING: default admin credentials active (admin@admin.com / password-target-server)");
	} else {
		console.warn("[target-server] WARNING: seeded admin@admin.com with TARGET_SEED_ADMIN_PASSWORD");
	}
}

function syncAdminSeedPassword(seedPassword) {
	const user = getAuthUserByEmail(DEFAULT_ADMIN_EMAIL);
	if (!user?.passwordHash) return;
	const hash = hashPasswordSync(seedPassword);
	open().prepare("UPDATE auth_users SET password_hash = ? WHERE email = ?").run(hash, DEFAULT_ADMIN_EMAIL);
	if (seedPassword === DEFAULT_ADMIN_PASSWORD) {
		console.warn("[target-server] WARNING: synced admin@admin.com password to the published default");
	} else {
		console.warn("[target-server] WARNING: synced admin@admin.com password to TARGET_SEED_ADMIN_PASSWORD");
	}
}

export function getJwtSecret() {
	const env = process.env.TARGET_AUTH_SECRET;
	if (env) return env;
	const row = open().prepare("SELECT jwt_secret FROM auth_meta WHERE id = 1").get();
	if (row) return row.jwt_secret;
	const secret = randomBytes(32).toString("base64url");
	const now = new Date().toISOString();
	open().prepare("INSERT INTO auth_meta (id, jwt_secret, created_at) VALUES (1, ?, ?)").run(secret, now);
	console.warn("[target-server] generated JWT secret and persisted it in auth_meta (set TARGET_AUTH_SECRET to override)");
	return secret;
}

export function getAuthUserById(id) {
	return rowToAuthUser(open().prepare("SELECT * FROM auth_users WHERE id = ?").get(id));
}

export function getAuthUserByEmail(email) {
	return rowToAuthUser(open().prepare("SELECT * FROM auth_users WHERE email = ?").get(email));
}

export function getAuthUserByGoogleSub(googleSub) {
	return rowToAuthUser(open().prepare("SELECT * FROM auth_users WHERE google_sub = ?").get(googleSub));
}

export function activateAuthUserWithGoogle(id, googleSub) {
	const now = new Date().toISOString();
	open()
		.prepare(
			`UPDATE auth_users
			 SET google_sub = ?, activated_at = COALESCE(activated_at, ?)
			 WHERE id = ?`,
		)
		.run(googleSub, now, id);
	return getAuthUserById(id);
}

export function listAuthUsers() {
	return open()
		.prepare("SELECT * FROM auth_users ORDER BY created_at ASC")
		.all()
		.map(rowToAuthUser);
}

export function countAuthUsers() {
	return open().prepare("SELECT COUNT(*) AS n FROM auth_users").get().n;
}

export function createAuthUser({
	email,
	createdBy = null,
	roleId = ADMIN_ROLE_ID,
	inviteAllowPassword = true,
	inviteAllowGoogle = false,
}) {
	if (!inviteAllowPassword && !inviteAllowGoogle) {
		throw new Error("createAuthUser: at least one invite activation method required");
	}
	requireRole(roleId);
	const now = new Date().toISOString();
	const id = randomUUID();
	open()
		.prepare(
			`INSERT INTO auth_users (
				id, email, password_hash, role, token_version, created_at, created_by, invited_at,
				invite_allow_password, invite_allow_google
			) VALUES (?, ?, NULL, ?, 1, ?, ?, ?, ?, ?)`,
		)
		.run(
			id,
			email,
			roleId,
			now,
			createdBy,
			now,
			inviteAllowPassword ? 1 : 0,
			inviteAllowGoogle ? 1 : 0,
		);
	return getAuthUserById(id);
}

export function deleteAuthUser(id) {
	const user = getAuthUserById(id);
	if (!user) return false;
	if (user.role === ADMIN_ROLE_ID && countAuthUsersByRole(ADMIN_ROLE_ID) <= 1) {
		throw rbacError("last_administrator", "cannot delete the last administrator");
	}
	open().prepare("DELETE FROM auth_resets WHERE user_id = ?").run(id);
	open().prepare("DELETE FROM auth_users WHERE id = ?").run(id);
	return true;
}

export function bumpTokenVersion(id) {
	open().prepare("UPDATE auth_users SET token_version = token_version + 1 WHERE id = ?").run(id);
	return getAuthUserById(id);
}

export function setUserPassword(id, passwordHash) {
	const now = new Date().toISOString();
	open()
		.prepare("UPDATE auth_users SET password_hash = ?, activated_at = COALESCE(activated_at, ?) WHERE id = ?")
		.run(passwordHash, now, id);
	return getAuthUserById(id);
}

export function recordLogin(id) {
	const now = new Date().toISOString();
	open().prepare("UPDATE auth_users SET last_login_at = ? WHERE id = ?").run(now, id);
	return getAuthUserById(id);
}

export function touchInvitedAt(id) {
	const now = new Date().toISOString();
	open().prepare("UPDATE auth_users SET invited_at = ? WHERE id = ?").run(now, id);
}

export function invalidateResetTokens(userId, kind) {
	open().prepare("DELETE FROM auth_resets WHERE user_id = ? AND kind = ? AND used_at IS NULL").run(userId, kind);
}

export function insertResetToken({ tokenHash, userId, kind, expiresAt }) {
	const now = new Date().toISOString();
	open()
		.prepare(
			`INSERT INTO auth_resets (token_hash, user_id, kind, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.run(tokenHash, userId, kind, now, expiresAt);
}

export function findResetToken(tokenHash) {
	const r = open().prepare("SELECT * FROM auth_resets WHERE token_hash = ?").get(tokenHash);
	if (!r) return null;
	return {
		tokenHash: r.token_hash,
		userId: r.user_id,
		kind: r.kind,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		usedAt: r.used_at,
	};
}

export function consumeResetToken(tokenHash) {
	const now = new Date().toISOString();
	const info = open().prepare("UPDATE auth_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").run(now, tokenHash);
	return info.changes > 0;
}

export function sweepExpiredResets() {
	const now = new Date().toISOString();
	open().prepare("DELETE FROM auth_resets WHERE expires_at < ? OR used_at IS NOT NULL").run(now);
}

export async function adminHasDefaultPassword() {
	const user = getAuthUserByEmail(DEFAULT_ADMIN_EMAIL);
	if (!user?.passwordHash) return false;
	const { verifyPassword } = await import("./auth.mjs");
	return await verifyPassword(DEFAULT_ADMIN_PASSWORD, user.passwordHash);
}

/** Upsert the instance identity carried by a batch envelope. */
export function upsertInstance(batch, nowIso) {
	open()
		.prepare(
			`INSERT INTO instances (instance_id, display_name, version, first_seen_at, last_seen_at, events_count)
			 VALUES (?, ?, ?, ?, ?, 0)
			 ON CONFLICT(instance_id) DO UPDATE SET
			   display_name = COALESCE(excluded.display_name, instances.display_name),
			   version      = COALESCE(excluded.version, instances.version),
			   last_seen_at = excluded.last_seen_at`,
		)
		.run(
			batch.instance_id,
			batch.user?.display_name ?? null,
			batch.version ?? null,
			nowIso,
			nowIso,
		);
}

/**
 * Insert one event idempotently. Returns "inserted" | "duplicate" | "rejected".
 * A missing id is the only hard reject (we can't dedupe it); everything else is
 * stored as-is.
 */
export function insertEvent(instanceId, version, event, nowIso) {
	if (!event || typeof event.id !== "string" || typeof event.kind !== "string") return "rejected";
	const info = open()
		.prepare(
			`INSERT OR IGNORE INTO events (id, instance_id, kind, workflow_id, session_id, version, created_at, received_at, data)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			event.id,
			instanceId,
			event.kind,
			event.workflow_id ?? null,
			event.session_id ?? null,
			version ?? null,
			typeof event.created_at === "string" ? event.created_at : null,
			nowIso,
			JSON.stringify(event.data ?? {}),
		);
	return info.changes > 0 ? "inserted" : "duplicate";
}

/** Bump an instance's stored event counter by however many rows we actually added. */
export function bumpInstanceCount(instanceId, added) {
	if (added <= 0) return;
	open().prepare("UPDATE instances SET events_count = events_count + ? WHERE instance_id = ?").run(added, instanceId);
}

// --- Read side, for the dashboard API -------------------------------------

/**
 * Shared WHERE builder for the dashboard filters. `user` is the instance's
 * display name (what the operator recognises); it resolves to every instance
 * carrying that name, so two machines reporting as the same user filter
 * together. `from`/`to` bound `received_at` (ISO strings compare lexically).
 */
function eventFilterWhere({ kind = null, instanceId = null, workflowId = null, user = null, agent = null, sandbox = null, from = null, to = null } = {}) {
	const clauses = [];
	const params = [];
	if (kind) {
		clauses.push("kind = ?");
		params.push(kind);
	}
	if (instanceId) {
		clauses.push("instance_id = ?");
		params.push(instanceId);
	}
	if (workflowId) {
		clauses.push("workflow_id = ?");
		params.push(workflowId);
	}
	// Agent/sandbox live inside workflow-scoped event payloads (workflow.created/
	// workflow.updated), not in columns — so filtering by them means "events of
	// the workflows that reported this value". Instance-level events (heartbeat)
	// have no workflow and drop out, which is correct: they belong to no agent.
	if (agent) {
		clauses.push("workflow_id IN (SELECT workflow_id FROM events WHERE json_extract(data, '$.agent') = ?)");
		params.push(agent);
	}
	if (sandbox) {
		clauses.push("workflow_id IN (SELECT workflow_id FROM events WHERE json_extract(data, '$.sandbox') = ?)");
		params.push(sandbox);
	}
	if (user) {
		clauses.push("instance_id IN (SELECT instance_id FROM instances WHERE COALESCE(display_name, '') = ?)");
		params.push(user);
	}
	if (from) {
		clauses.push("received_at >= ?");
		params.push(from);
	}
	if (to) {
		clauses.push("received_at <= ?");
		params.push(to);
	}
	return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** The distinct reporting users (instance display names) for the filter dropdown. */
export function listUsers() {
	return open()
		.prepare(
			`SELECT COALESCE(NULLIF(display_name, ''), 'anonymous') AS name,
			        COUNT(*) AS instances,
			        SUM(events_count) AS events,
			        MAX(last_seen_at) AS last_seen_at
			 FROM instances GROUP BY name ORDER BY events DESC`,
		)
		.all()
		.map((r) => ({ name: r.name, instances: r.instances, events: r.events ?? 0, lastSeenAt: r.last_seen_at }));
}

export function listInstances() {
	return open()
		.prepare("SELECT * FROM instances ORDER BY last_seen_at DESC")
		.all()
		.map((r) => ({
			instanceId: r.instance_id,
			displayName: r.display_name,
			version: r.version,
			firstSeenAt: r.first_seen_at,
			lastSeenAt: r.last_seen_at,
			eventsCount: r.events_count,
		}));
}

export function recentEvents({ limit = 100, kind = null, instanceId = null, workflowId = null, user = null, agent = null, sandbox = null, from = null, to = null } = {}) {
	const { where, params } = eventFilterWhere({ kind, instanceId, workflowId, user, agent, sandbox, from, to });
	const rows = open()
		.prepare(`SELECT * FROM events ${where} ORDER BY received_at DESC, rowid DESC LIMIT ?`)
		.all(...params, Math.min(Math.max(1, limit), 1000));
	return rows.map(rowToEvent);
}

function rowToEvent(r) {
	let data = {};
	try {
		data = JSON.parse(r.data ?? "{}");
	} catch {
		data = { _unparsed: r.data };
	}
	return {
		id: r.id,
		instanceId: r.instance_id,
		kind: r.kind,
		workflowId: r.workflow_id,
		sessionId: r.session_id,
		version: r.version,
		createdAt: r.created_at,
		receivedAt: r.received_at,
		data,
	};
}

/**
 * Aggregate stats, honouring the same dashboard filters as recentEvents.
 * Event-derived numbers (totals, workflows, failures, byKind, usage) carry the
 * filters; instance-derived numbers (fleet size, versions) honour only the
 * user/instance side of them, which is what an operator narrowing to "Ada on
 * machine X last week" expects the fleet panels to answer.
 */
export function stats({ kind = null, instanceId = null, workflowId = null, user = null, agent = null, sandbox = null, from = null, to = null } = {}) {
	const d = open();
	const ev = eventFilterWhere({ kind, instanceId, workflowId, user, agent, sandbox, from, to });
	const and = (extra) => (ev.where ? `${ev.where} AND ${extra}` : `WHERE ${extra}`);

	const totalEvents = d.prepare(`SELECT COUNT(*) AS n FROM events ${ev.where}`).get(...ev.params).n;

	// Instances: filtered by the identity filters only (a date range must not
	// shrink the fleet list itself).
	const instClauses = [];
	const instParams = [];
	if (instanceId) {
		instClauses.push("instance_id = ?");
		instParams.push(instanceId);
	}
	if (user) {
		instClauses.push("COALESCE(display_name, '') = ?");
		instParams.push(user);
	}
	const instWhere = instClauses.length ? `WHERE ${instClauses.join(" AND ")}` : "";
	const totalInstances = d.prepare(`SELECT COUNT(*) AS n FROM instances ${instWhere}`).get(...instParams).n;

	const workflows = d
		.prepare(`SELECT COUNT(DISTINCT workflow_id) AS n FROM events ${and("workflow_id IS NOT NULL")}`)
		.get(...ev.params).n;
	// Steps that are failed NOW, not every failure ever recorded. A step that
	// failed and was then re-run successfully is not a standing failure, but
	// counting `step.failed` rows made it one permanently — the dashboard kept
	// reporting a failure for a workflow whose every step had since passed.
	// So: per step, keep only its latest lifecycle event, then count the failures.
	// A lifecycle event with no `step_id` can't be grouped with its siblings, so
	// it partitions by its own event id — it is its own one-event step, which
	// keeps the old counting for anything that doesn't identify its step.
	const failures = d
		.prepare(
			`SELECT COUNT(*) AS n FROM (
			   SELECT kind AS final_kind,
			          ROW_NUMBER() OVER (
			            PARTITION BY workflow_id, COALESCE(json_extract(data, '$.step_id'), id)
			            ORDER BY received_at DESC, rowid DESC
			          ) AS rn
			   FROM events
			   ${and("kind IN ('step.added','step.started','step.waiting','step.done','step.failed')")}
			 ) WHERE rn = 1 AND final_kind = 'step.failed'`,
		)
		.get(...ev.params).n;
	const byKind = d
		.prepare(`SELECT kind, COUNT(*) AS n FROM events ${ev.where} GROUP BY kind ORDER BY n DESC`)
		.all(...ev.params)
		.map((r) => ({ kind: r.kind, count: r.n }));
	const byVersion = d
		.prepare(`SELECT version, COUNT(*) AS n FROM instances ${instWhere} GROUP BY version ORDER BY n DESC`)
		.all(...instParams)
		.map((r) => ({ version: r.version ?? "unknown", count: r.n }));
	// The distinct agents/sandboxes ever reported, for the filter dropdowns.
	// Deliberately UNFILTERED: the options must stay put while one of them is
	// selected (same trick the UI pulls with an unfiltered /api/stats for kinds).
	const agents = d
		.prepare(`SELECT DISTINCT json_extract(data, '$.agent') AS a FROM events WHERE json_extract(data, '$.agent') IS NOT NULL ORDER BY a`)
		.all()
		.map((r) => r.a);
	const sandboxes = d
		.prepare(`SELECT DISTINCT json_extract(data, '$.sandbox') AS s FROM events WHERE json_extract(data, '$.sandbox') IS NOT NULL ORDER BY s`)
		.all()
		.map((r) => r.s);
	// Last snapshot per session, summed — see `latestUsageTotals` for why summing
	// the snapshots themselves multiplies the real spend.
	const usage = latestUsageTotals(and("kind = 'usage.snapshot'"), ev.params);
	return {
		totalEvents,
		totalInstances,
		workflows,
		failures,
		byKind,
		byVersion,
		agents,
		sandboxes,
		usage: { inputTokens: usage.input, outputTokens: usage.output },
	};
}

// --- Workflow aggregation (the workflow-centric dashboard views) ------------
//
// The hub reports a workflow two ways, and the difference matters:
//
//  - as a STREAM of events (§7): workflow.created opens it, step.added records
//    the plan, step.started/done/failed/judged track execution. The stream is
//    the TIMELINE — durations, token attribution, what happened when. It cannot
//    be trusted to describe the present, because a single dropped event leaves
//    its last word standing forever (a finished step stuck reading `running`),
//    and edits/removals/reorders were never in the stream at all.
//
//  - as a `workflow.plan` SNAPSHOT: the whole step list, with every field the
//    operator's canvas lays out from, re-sent whenever the plan changes. This
//    is the PRESENT, and it self-heals — a lost event is corrected by the next
//    snapshot rather than living forever.
//
// So: the snapshot wins wherever it exists, and the stream fold below stays as
// the fallback for a hub too old to send one.

/**
 * The newest `workflow.plan` per workflow id. Rows come oldest-first so the
 * last write per workflow IS the latest; a snapshot that won't parse is simply
 * not a snapshot, and that workflow falls back to the event fold.
 */
function latestPlans(workflowIds) {
	if (workflowIds.length === 0) return new Map();
	const rows = open()
		.prepare(
			`SELECT workflow_id AS wf, data, received_at AS at
			 FROM events
			 WHERE kind = 'workflow.plan' AND workflow_id IN (${workflowIds.map(() => "?").join(",")})
			 ORDER BY received_at ASC, rowid ASC`,
		)
		.all(...workflowIds);
	const out = new Map();
	for (const r of rows) {
		try {
			const data = JSON.parse(r.data ?? "{}");
			if (Array.isArray(data.steps)) out.set(r.wf, { ...data, receivedAt: r.at });
		} catch {
			// Unparseable snapshot: leave whatever earlier one we had.
		}
	}
	return out;
}

/** A plan's task steps — the context step is real, but it is not one of the N. */
function planTaskSteps(plan) {
	return plan ? plan.steps.filter((s) => s && s.kind !== "context") : null;
}

/**
 * A `usage.snapshot` payload, read the way the operator's own client reads it.
 *
 * The hub used to report only the bare `input_tokens` field, which counts the
 * UNCACHED input alone. With prompt caching on that is a rounding error: one
 * real session reported 416 there against 16,015,192 tokens actually sent, and
 * this dashboard's INPUT TOKENS tile duly said 416 where the client said
 * "in 16.0M". Newer hubs send the full total under `input_tokens` and keep the
 * parts beside it (`input_tokens_uncached` / `cache_creation` / `cache_read`),
 * plus the context window, the model and the turn count the client prints.
 *
 * The old rows already carry `cache_read` and `cache_creation`, so history is
 * correctable on READ — no migration, and nothing a client once sent is
 * rewritten:
 *
 *   old shape → input_tokens + cache_creation + cache_read
 *   new shape → input_tokens, untouched (re-adding the parts would count
 *               ~16M of it twice)
 *
 * A payload is new-shape when it carries a field only the new hub sends:
 * `input_tokens_uncached` or `context_window`.
 */
export function isNewUsageShape(data) {
	return !!data && (data.input_tokens_uncached != null || data.context_window != null);
}

/** One `usage.snapshot` payload → the camelCase shape the dashboard reads. */
export function normalizeUsageSnapshot(data) {
	const d = data ?? {};
	const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const isNew = isNewUsageShape(d);
	const cacheCreation = num(d.cache_creation);
	const cacheRead = num(d.cache_read);
	const uncached = isNew ? num(d.input_tokens_uncached) : num(d.input_tokens);
	const inputTokens = isNew ? num(d.input_tokens) : uncached + cacheCreation + cacheRead;
	const contextTokens = num(d.context_tokens);
	const contextWindow = num(d.context_window);
	return {
		inputTokens,
		outputTokens: num(d.output_tokens),
		inputTokensUncached: uncached,
		cacheCreation,
		cacheRead,
		contextTokens,
		contextWindow,
		contextPct:
			typeof d.context_pct === "number" ? d.context_pct : contextWindow > 0 ? (100 * contextTokens) / contextWindow : 0,
		model: typeof d.model === "string" ? d.model : null,
		turns: num(d.turns),
		includesSubagents: d.includes_subagents === true,
		compacted: d.compacted === true,
		costUsd: typeof d.cost_usd === "number" ? d.cost_usd : null,
	};
}

/**
 * `normalizeUsageSnapshot`'s input rule as a SQL expression, so the aggregate
 * sums below correct history in the same place SQLite is already summing it.
 * Kept beside the JS version on purpose — `test/usage.test.mjs` asserts the two
 * agree on the same fixtures, which is what stops them drifting apart.
 */
const INPUT_TOKENS_SQL = `CASE
			            WHEN json_extract(data, '$.input_tokens_uncached') IS NOT NULL
			              OR json_extract(data, '$.context_window') IS NOT NULL
			            THEN COALESCE(json_extract(data, '$.input_tokens'), 0)
			            ELSE COALESCE(json_extract(data, '$.input_tokens'), 0)
			               + COALESCE(json_extract(data, '$.cache_creation'), 0)
			               + COALESCE(json_extract(data, '$.cache_read'), 0)
			          END`;

/**
 * Token totals, counted correctly.
 *
 * A `usage.snapshot` carries the RUNNING TOTAL of its Claude session, not that
 * step's own spend — the hub re-reads the whole transcript each time. Summing
 * the snapshots therefore counts every earlier turn again on every step: a
 * three-step workflow reporting 1600 → 1872 → 1932 was displayed as 5404 when
 * it had actually spent 1932, and the error grows with every step.
 *
 * The right total is the LAST snapshot per session, summed across sessions —
 * sessions are genuinely separate spends, snapshots within one are not.
 *
 * `extraWhere`/`params` scope it to whatever the caller is totalling (one
 * workflow, or a filtered dashboard).
 */
function latestUsageTotals(extraWhere, params) {
	const row = open()
		.prepare(
			`SELECT COALESCE(SUM(t.input), 0) AS input, COALESCE(SUM(t.output), 0) AS output
			 FROM (
			   SELECT ${INPUT_TOKENS_SQL} AS input,
			          COALESCE(json_extract(data, '$.output_tokens'), 0) AS output,
			          ROW_NUMBER() OVER (
			            PARTITION BY workflow_id, COALESCE(session_id, '')
			            ORDER BY received_at DESC, rowid DESC
			          ) AS rn
			   FROM events
			   ${extraWhere}
			 ) t
			 WHERE t.rn = 1`,
		)
		.get(...params);
	return { input: row?.input ?? 0, output: row?.output ?? 0 };
}

/**
 * One workflow's usage, per session, the way the client states it.
 *
 * Same counting rule as `latestUsageTotals` — the LAST snapshot of each session
 * — but it keeps the snapshots whole instead of summing them down to two
 * numbers, because the context meter, the turn count and the model belong to a
 * session and cannot be added up across several. Newest session first.
 */
export function workflowUsage(workflowId) {
	const rows = open()
		.prepare(
			`SELECT t.session_id AS sessionId, t.data AS data, t.received_at AS receivedAt
			 FROM (
			   SELECT session_id, data, received_at,
			          ROW_NUMBER() OVER (
			            PARTITION BY COALESCE(session_id, '')
			            ORDER BY received_at DESC, rowid DESC
			          ) AS rn
			   FROM events
			   WHERE kind = 'usage.snapshot' AND workflow_id = ?
			 ) t
			 WHERE t.rn = 1
			 ORDER BY t.received_at DESC`,
		)
		.all(workflowId);
	const sessions = rows.map((r) => {
		let data = {};
		try {
			data = JSON.parse(r.data ?? "{}");
		} catch {
			data = {};
		}
		return { sessionId: r.sessionId ?? null, receivedAt: r.receivedAt, ...normalizeUsageSnapshot(data) };
	});
	return {
		inputTokens: sessions.reduce((n, s) => n + s.inputTokens, 0),
		outputTokens: sessions.reduce((n, s) => n + s.outputTokens, 0),
		sessions,
	};
}

/** Per-workflow token totals, same counting rule as `latestUsageTotals`. */
function usageByWorkflow(workflowIds) {
	if (workflowIds.length === 0) return new Map();
	const rows = open()
		.prepare(
			`SELECT t.workflow_id AS wf,
			        COALESCE(SUM(t.input), 0)  AS input,
			        COALESCE(SUM(t.output), 0) AS output
			 FROM (
			   SELECT workflow_id,
			          ${INPUT_TOKENS_SQL} AS input,
			          COALESCE(json_extract(data, '$.output_tokens'), 0) AS output,
			          ROW_NUMBER() OVER (
			            PARTITION BY workflow_id, COALESCE(session_id, '')
			            ORDER BY received_at DESC, rowid DESC
			          ) AS rn
			   FROM events
			   WHERE kind = 'usage.snapshot'
			     AND workflow_id IN (${workflowIds.map(() => "?").join(",")})
			 ) t
			 WHERE t.rn = 1
			 GROUP BY t.workflow_id`,
		)
		.all(...workflowIds);
	return new Map(rows.map((r) => [r.wf, { input: r.input, output: r.output }]));
}

/**
 * One aggregate row per workflow_id over the events matching the identity/date
 * filters. Counts, first/last activity and token sums honour those filters —
 * they answer "what happened in this range". The name, the owning instance
 * and the derived status resolve from the workflow's FULL history instead, so
 * narrowing the range can never blank a workflow's identity or misread a run
 * that started before it.
 *
 * Rows are ordered newest activity first, with workflow_id as a tiebreaker.
 * That second key is not cosmetic: workflows ingested in the same flush share a
 * received_at, and `ORDER BY lastActivityAt DESC` alone leaves their relative
 * order undefined — which under LIMIT/OFFSET means a row could be repeated on
 * one page and skipped on the next. The tiebreaker makes the order total, so
 * paging through the list is guaranteed to visit every workflow exactly once.
 */
function workflowAggregates({
	instanceId = null,
	user = null,
	agent = null,
	sandbox = null,
	from = null,
	to = null,
	workflowId = null,
	limit = null,
	offset = 0,
} = {}) {
	const d = open();
	const ev = eventFilterWhere({ instanceId, user, agent, sandbox, from, to, workflowId });
	const and = (extra) => (ev.where ? `${ev.where} AND ${extra}` : `WHERE ${extra}`);
	// Paging is applied to the GROUP BY above, not to the result — everything
	// below this query (the plan snapshots, the usage totals, the lifecycle fold)
	// runs per row, so a page of 25 costs a page of 25 regardless of how many
	// workflows the filters match.
	const page = limit == null ? "" : `LIMIT ${Number(limit)} OFFSET ${Number(offset) || 0}`;
	const rows = d
		.prepare(
			`SELECT e.workflow_id AS workflowId,
			        MIN(e.received_at) AS firstSeenAt,
			        MAX(e.received_at) AS lastActivityAt,
			        SUM(e.kind = 'step.added')   AS stepsAdded,
			        SUM(e.kind = 'step.started') AS stepsStarted,
			        SUM(e.kind = 'step.done')    AS stepsDone,
			        SUM(e.kind = 'step.failed')  AS stepsFailed,
			        MAX(CASE WHEN e.kind LIKE 'step.%' THEN CAST(json_extract(e.data, '$.order_index') AS INTEGER) END) AS maxOrder,
			        (SELECT json_extract(c.data, '$.name') FROM events c
			          WHERE c.workflow_id = e.workflow_id AND c.kind IN ('workflow.created', 'workflow.updated')
			            AND json_extract(c.data, '$.name') IS NOT NULL
			          ORDER BY c.received_at DESC, c.rowid DESC LIMIT 1) AS name,
			        (SELECT json_extract(a.data, '$.agent') FROM events a
			          WHERE a.workflow_id = e.workflow_id AND json_extract(a.data, '$.agent') IS NOT NULL
			          ORDER BY a.received_at DESC, a.rowid DESC LIMIT 1) AS agent,
			        (SELECT json_extract(b.data, '$.sandbox') FROM events b
			          WHERE b.workflow_id = e.workflow_id AND json_extract(b.data, '$.sandbox') IS NOT NULL
			          ORDER BY b.received_at DESC, b.rowid DESC LIMIT 1) AS sandbox,
			        (SELECT json_extract(i.data, '$.image') FROM events i
			          WHERE i.workflow_id = e.workflow_id AND json_extract(i.data, '$.image') IS NOT NULL
			          ORDER BY i.received_at DESC, i.rowid DESC LIMIT 1) AS image,
			        (SELECT json_extract(s.data, '$.to') FROM events s
			          WHERE s.workflow_id = e.workflow_id AND s.kind = 'workflow.status_changed'
			            AND json_extract(s.data, '$.to') IS NOT NULL
			          ORDER BY s.received_at DESC, s.rowid DESC LIMIT 1) AS statusTo,
			        (SELECT l.instance_id FROM events l
			          WHERE l.workflow_id = e.workflow_id
			          ORDER BY l.received_at DESC, l.rowid DESC LIMIT 1) AS instanceId
			 FROM events e
			 ${and("e.workflow_id IS NOT NULL")}
			 GROUP BY e.workflow_id
			 ORDER BY lastActivityAt DESC, e.workflow_id DESC
			 ${page}`,
		)
		.all(...ev.params);

	// Status: the NEWEST signal wins. An explicit terminal transition
	// (workflow.status_changed) settles the workflow — unless a step started
	// AFTER it and is still unsettled (the hub drives manual per-step runs that
	// flip the workflow completed→running without a new status_changed, so an
	// old terminal event must not mask live work). Symmetrically, a step ADDED
	// after a terminal transition reopens the workflow — the hub flips it back
	// to draft in addStep, so a pending step newer than the last 'completed'
	// reads 'draft' here even if that status_changed event was lost (e.g. a hub
	// restart mid-run). With no terminal transition at all, any in-flight step
	// reads 'running', else 'draft'.
	const statusAt = new Map(); // workflowId → received_at of latest status_changed
	{
		const sc = d
			.prepare(
				`SELECT workflow_id AS wf, MAX(received_at) AS at
				 FROM events WHERE kind = 'workflow.status_changed' AND workflow_id IN (${rows.map(() => "?").join(",") || "NULL"})
				 GROUP BY workflow_id`,
			)
			.all(...rows.map((r) => r.workflowId));
		for (const r of sc) statusAt.set(r.wf, r.at);
	}
	const running = new Set();
	const reopened = new Set(); // terminal status + a newer pending step → draft
	const TERMINAL = new Set(["completed", "failed", "cancelled"]);
	const latest = new Map(); // workflowId → Map(stepId → {kind, at})
	if (rows.length > 0) {
		const life = d
			.prepare(
				`SELECT workflow_id AS wf, COALESCE(json_extract(data, '$.step_id'), id) AS sid, kind, received_at AS at
				 FROM events
				 WHERE kind IN ('step.added', 'step.started', 'step.waiting', 'step.done', 'step.failed')
				   AND workflow_id IN (${rows.map(() => "?").join(",")})
				 ORDER BY received_at ASC, rowid ASC`,
			)
			.all(...rows.map((r) => r.workflowId));
		for (const r of life) {
			let perStep = latest.get(r.wf);
			if (!perStep) latest.set(r.wf, (perStep = new Map()));
			// Ascending received_at/rowid (rowid breaks the same-flush timestamp
			// ties): the last write per step IS the latest.
			perStep.set(r.sid, { kind: r.kind, at: r.at });
		}
		for (const [wf, perStep] of latest) {
			const row = rows.find((r) => r.workflowId === wf);
			const changedAt = statusAt.get(wf) ?? "";
			for (const { kind, at } of perStep.values()) {
				if (kind === "step.started" && at > changedAt) {
					running.add(wf);
					break;
				}
				// step.added as a step's LATEST lifecycle row means "planned, never
				// ran" — pending work the terminal badge would otherwise hide.
				if (kind === "step.added" && at > changedAt && row && TERMINAL.has(row.statusTo)) reopened.add(wf);
			}
		}
	}

	// Instance display names, one lookup for the whole page of rows.
	const instIds = [...new Set(rows.map((r) => r.instanceId).filter(Boolean))];
	const displayNames = new Map();
	if (instIds.length > 0) {
		for (const r of d
			.prepare(`SELECT instance_id, display_name FROM instances WHERE instance_id IN (${instIds.map(() => "?").join(",")})`)
			.all(...instIds)) {
			displayNames.set(r.instance_id, r.display_name);
		}
	}

	const plans = latestPlans(rows.map((r) => r.workflowId));
	const usage = usageByWorkflow(rows.map((r) => r.workflowId));

	return rows.map((r) => {
		const plan = plans.get(r.workflowId) ?? null;
		const planSteps = planTaskSteps(plan);
		// Counting from the per-step LATEST lifecycle event, not from raw event
		// totals. A step that failed and was then re-run successfully is one done
		// step, not one done and one failed — summing `kind = 'step.failed'` rows
		// made an old, superseded failure permanent on the dashboard. Same reason
		// the plan length can't be a count of `step.started`: retries re-start the
		// same step, and that inflated the progress bar's denominator for good.
		const perStep = latest.get(r.workflowId) ?? new Map();
		const settled = { done: 0, failed: 0 };
		for (const { kind } of perStep.values()) {
			if (kind === "step.done") settled.done++;
			else if (kind === "step.failed") settled.failed++;
		}
		const stepsDone = planSteps ? planSteps.filter((s) => s.status === "done").length : settled.done;
		const stepsFailed = planSteps ? planSteps.filter((s) => s.status === "failed").length : settled.failed;
		return {
			workflowId: r.workflowId,
			name: plan?.name ?? r.name ?? r.workflowId.slice(0, 8),
			user: (r.instanceId && displayNames.get(r.instanceId)) || null,
			instanceId: r.instanceId,
			agent: r.agent ?? null,
			sandbox: r.sandbox ?? null,
			image: r.image ?? null,
			firstSeenAt: r.firstSeenAt,
			lastActivityAt: r.lastActivityAt,
			stepsAdded: r.stepsAdded,
			stepsStarted: r.stepsStarted,
			stepsDone,
			stepsFailed,
			// The plan size the progress bar divides by. A snapshot answers it
			// outright. Without one: distinct step ids seen in lifecycle events, and
			// any step's order_index pins the length from below (order 4 ⇒ at least
			// 5 steps), which covers a pending step that hasn't run yet.
			stepsTotal: planSteps
				? planSteps.length
				: Math.max(r.stepsAdded, (r.maxOrder ?? -1) + 1, perStep.size, stepsDone + stepsFailed),
			tokens: usage.get(r.workflowId) ?? { input: 0, output: 0 },
			// The snapshot is the present tense and wins outright: the hub emits it
			// after the status transition it reflects, so it is never staler.
			status: plan
				? plan.status
				: running.has(r.workflowId)
					? "running"
					: reopened.has(r.workflowId)
						? "draft"
						: (r.statusTo ?? "draft"),
			/** Whether this row's shape came from a snapshot — the canvas needs one. */
			hasPlan: !!planSteps,
		};
	});
}

/** How many workflows the identity/date filters match, for the pager's "of N". */
export function countWorkflows({ instanceId = null, user = null, agent = null, sandbox = null, from = null, to = null } = {}) {
	const ev = eventFilterWhere({ instanceId, user, agent, sandbox, from, to });
	const where = ev.where ? `${ev.where} AND workflow_id IS NOT NULL` : "WHERE workflow_id IS NOT NULL";
	return open()
		.prepare(`SELECT COUNT(DISTINCT workflow_id) AS total FROM events ${where}`)
		.get(...ev.params).total;
}

/**
 * One page of the workflow list for the dashboard, newest activity first.
 * Honours the identity/date filters only — narrowing by event kind or by
 * workflow would filter the list itself away, so those two are deliberately
 * ignored here.
 *
 * `total` is the unpaged match count: the pager needs to say "of 1,347" without
 * fetching 1,347 rows, which is the whole point of paging this list.
 */
export function listWorkflows({
	instanceId = null,
	user = null,
	agent = null,
	sandbox = null,
	from = null,
	to = null,
	limit = null,
	offset = 0,
} = {}) {
	const filters = { instanceId, user, agent, sandbox, from, to };
	return {
		workflows: workflowAggregates({ ...filters, limit, offset }),
		total: countWorkflows(filters),
		limit,
		offset,
	};
}

/**
 * Just the id+name of every matching workflow, for the filter bar's dropdown.
 *
 * The dropdown has to keep offering workflows that are not on the current page,
 * so it cannot read from the paged list. This query skips the whole per-row fold
 * (plans, usage, lifecycle) and stays cheap even with thousands of rows.
 */
export function listWorkflowNames({ instanceId = null, user = null, agent = null, sandbox = null, from = null, to = null, limit = 1000 } = {}) {
	const ev = eventFilterWhere({ instanceId, user, agent, sandbox, from, to });
	const where = ev.where ? `${ev.where} AND e.workflow_id IS NOT NULL` : "WHERE e.workflow_id IS NOT NULL";
	return open()
		.prepare(
			`SELECT e.workflow_id AS workflowId,
			        MAX(e.received_at) AS lastActivityAt,
			        (SELECT json_extract(c.data, '$.name') FROM events c
			          WHERE c.workflow_id = e.workflow_id AND c.kind IN ('workflow.created', 'workflow.updated')
			            AND json_extract(c.data, '$.name') IS NOT NULL
			          ORDER BY c.received_at DESC, c.rowid DESC LIMIT 1) AS name
			 FROM events e
			 ${where}
			 GROUP BY e.workflow_id
			 ORDER BY lastActivityAt DESC, e.workflow_id DESC
			 LIMIT ${Number(limit)}`,
		)
		.all(...ev.params)
		.map((r) => ({ workflowId: r.workflowId, name: r.name ?? r.workflowId.slice(0, 8) }));
}

/**
 * The workflow-centric detail: the step list, the workflow's summary row (full
 * history), and its recent events.
 *
 * The step list comes from the newest `workflow.plan` snapshot when there is
 * one, because that is the only source that describes the workflow as it IS —
 * including the steps that have never run, the ones that were edited or
 * reordered after the fact, the hub-owned context step, and the flags the
 * canvas draws from (subagent, acceptance criteria, retry budget, selection).
 *
 * The event fold still runs, and still supplies what a snapshot structurally
 * cannot: how long each step took, and what its judge said. The two are merged
 * per step id — plan for shape and state, events for history.
 *
 * With no snapshot (a hub too old to send one) the fold is the whole answer,
 * exactly as before: the latest step.added per step_id carries the plan; the
 * latest lifecycle event carries the run state.
 */
/** Fold sticky-note events into per-step note lists (latest state wins). */
function foldStepNotes(workflowId) {
	const rows = open()
		.prepare(
			`SELECT kind, data, created_at AS createdAt
			 FROM events
			 WHERE workflow_id = ?
			   AND kind IN ('step.note.added', 'step.note.modified', 'step.note.deleted')
			 ORDER BY received_at ASC, rowid ASC`,
		)
		.all(workflowId);
	/** stepId → noteId → note */
	const byStep = new Map();
	for (const r of rows) {
		let data;
		try {
			data = JSON.parse(r.data ?? "{}");
		} catch {
			continue;
		}
		const stepId = typeof data.step_id === "string" ? data.step_id : null;
		const noteId = typeof data.note_id === "string" ? data.note_id : null;
		if (!stepId || !noteId) continue;
		let notes = byStep.get(stepId);
		if (!notes) {
			notes = new Map();
			byStep.set(stepId, notes);
		}
		if (r.kind === "step.note.deleted") {
			notes.delete(noteId);
			continue;
		}
		const theme = data.theme === "warning" || data.theme === "success" ? data.theme : "neutral";
		let content = typeof data.content === "string" ? data.content : null;
		if (!content && typeof data.content_len === "number") {
			content = `(${data.content_len} characters — reported before note text was included)`;
		}
		notes.set(noteId, { id: noteId, theme, content: content ?? "", updatedAt: r.createdAt });
	}
	const out = new Map();
	for (const [stepId, notes] of byStep) {
		out.set(
			stepId,
			[...notes.values()].filter((n) => n.content !== ""),
		);
	}
	return out;
}

export function workflowDetail(workflowId) {
	const d = open();
	const summary = workflowAggregates({ workflowId })[0];
	if (!summary) return null;
	const rows = d
		.prepare(
			`SELECT kind, data, created_at AS createdAt
			 FROM events
			 WHERE workflow_id = ?
			   AND kind IN ('step.added', 'step.started', 'step.waiting', 'step.done', 'step.failed', 'step.judged')
			 ORDER BY received_at ASC, rowid ASC`,
		)
		.all(workflowId);

	const steps = new Map(); // stepId → accumulator, in first-seen order
	for (const r of rows) {
		let data;
		try {
			data = JSON.parse(r.data ?? "{}");
		} catch {
			continue;
		}
		const stepId = typeof data.step_id === "string" ? data.step_id : null;
		if (!stepId) continue;
		let acc = steps.get(stepId);
		if (!acc) {
			acc = {
				stepId,
				kind: "task",
				orderIndex: null,
				description: null,
				status: "pending",
				phase: "exec",
				statusAt: null,
				durationMs: null,
				retryCount: null,
				maxRetries: null,
				startedAt: null,
				finishedAt: null,
				judged: null,
				manualReview: false,
				hasAcceptanceCriteria: false,
				acceptanceCriteria: null,
				useSubagent: true,
				selected: true,
				seq: steps.size,
			};
			steps.set(stepId, acc);
		}
		if (typeof data.order_index === "number") acc.orderIndex = data.order_index;
		if (typeof data.max_retries === "number") acc.maxRetries = data.max_retries;
		// `use_subagent` has always ridden along in step.started and was simply
		// never read — the canvas needs it to know whether to draw the box.
		if (typeof data.use_subagent === "boolean") acc.useSubagent = data.use_subagent;
		// Rows arrive oldest-first, so each kind overwrites what it knows and the
		// latest event of that kind wins.
		if (r.kind === "step.added") {
			if (typeof data.description === "string") acc.description = data.description;
			acc.manualReview = data.manual_review === true;
			acc.hasAcceptanceCriteria = data.has_acceptance_criteria === true;
		} else if (r.kind === "step.started") {
			acc.status = "running";
			// Which job is in flight: exec, or the judge evaluating the result. This
			// is what lights the judge circle instead of the card.
			acc.phase = data.phase === "judge" ? "judge" : "exec";
			acc.statusAt = r.createdAt;
			if (typeof data.acceptance_criteria === "string" && data.acceptance_criteria) {
				acc.acceptanceCriteria = data.acceptance_criteria;
				acc.hasAcceptanceCriteria = true;
			}
		} else if (r.kind === "step.waiting") {
			// The manual-review gate: the run finished, a human has to sign it off.
			acc.status = "waiting";
			acc.statusAt = r.createdAt;
			acc.manualReview = true;
		} else if (r.kind === "step.done" || r.kind === "step.failed") {
			acc.status = r.kind === "step.done" ? "done" : "failed";
			acc.statusAt = r.createdAt;
			if (typeof data.duration_ms === "number") acc.durationMs = data.duration_ms;
			if (typeof data.retry_count === "number") acc.retryCount = data.retry_count;
			// started/finished timestamps ride at the top level or inside the
			// §7.3 error object, depending on the kind.
			if (typeof data.started_at === "string") acc.startedAt = data.started_at;
			if (typeof data.finished_at === "string") acc.finishedAt = data.finished_at;
			if (data.error && typeof data.error === "object") {
				if (typeof data.error.started_at === "string") acc.startedAt = data.error.started_at;
				if (typeof data.error.finished_at === "string") acc.finishedAt = data.error.finished_at;
			}
		} else if (r.kind === "step.judged") {
			acc.judged = data.ok === true ? "pass" : "fail";
			if (typeof data.acceptance_criteria === "string" && data.acceptance_criteria) {
				acc.acceptanceCriteria = data.acceptance_criteria;
				acc.hasAcceptanceCriteria = true;
			}
		}
	}

	const folded = [...steps.values()]
		.sort((a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq)
		.map(({ seq, ...step }) => step);

	const plan = latestPlans([workflowId]).get(workflowId) ?? null;
	const byId = new Map(folded.map((s) => [s.stepId, s]));
	// Plan for shape and present state; fold for the history a snapshot can't
	// carry (durations, the judge's verdict, when the status last moved).
	const orderedSteps = plan
		? plan.steps
				.filter((s) => s && typeof s.step_id === "string")
				.map((s) => {
					const past = byId.get(s.step_id) ?? {};
					return {
						stepId: s.step_id,
						kind: s.kind === "context" ? "context" : "task",
						orderIndex: typeof s.order_index === "number" ? s.order_index : null,
						description: s.description ?? past.description ?? null,
						status: s.status ?? "pending",
						phase: s.phase === "judge" ? "judge" : "exec",
						statusAt: past.statusAt ?? null,
						durationMs: past.durationMs ?? null,
						retryCount: typeof s.retry_count === "number" ? s.retry_count : (past.retryCount ?? null),
						maxRetries: typeof s.max_retries === "number" ? s.max_retries : (past.maxRetries ?? null),
						startedAt: s.started_at ?? past.startedAt ?? null,
						finishedAt: s.finished_at ?? past.finishedAt ?? null,
						judged: past.judged ?? null,
						manualReview: s.manual_review === true,
						hasAcceptanceCriteria: !!s.acceptance_criteria,
						acceptanceCriteria: s.acceptance_criteria ?? null,
						useSubagent: s.use_subagent !== false,
						manualRun: s.manual_run === true,
						selected: s.selected === true,
					};
				})
				.sort((a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER))
		: folded;

	const notesByStep = foldStepNotes(workflowId);
	const stepsWithNotes = orderedSteps.map((s) => ({
		...s,
		notes: notesByStep.get(s.stepId) ?? [],
	}));

	return {
		workflow: summary,
		steps: stepsWithNotes,
		// The per-session readout the operator's own client prints. The tokens on
		// `summary` are the same spend rolled into two numbers; this is what lets
		// the two be compared line for line.
		usage: workflowUsage(workflowId),
		events: recentEvents({ workflowId, limit: 50 }),
	};
}

// --- Remote sync layer (docs/remote-sync.md) --------------------------------

function rowToClient(r) {
	if (!r) return null;
	let capabilities = null;
	if (r.capabilities_json) {
		try {
			capabilities = JSON.parse(r.capabilities_json);
		} catch {
			capabilities = null;
		}
	}
	return {
		id: r.id,
		name: r.name,
		tokenHash: r.token_hash,
		status: r.status,
		capabilities,
		lastSeenAt: r.last_seen_at,
		createdAt: r.created_at,
	};
}

function rowToRemoteWorkflow(r) {
	if (!r) return null;
	return {
		id: r.id,
		clientId: r.client_id,
		name: r.name,
		status: r.status,
		localId: r.local_id,
		conversationContext: r.conversation_context ?? null,
		sandbox: r.sandbox ?? "docker",
		stepCount: r.step_count ?? undefined,
		stepsPendingSync: r.steps_pending_sync ?? undefined,
		agent: r.agent ?? null,
		createdAt: r.created_at,
	};
}

function rowToRemoteStep(r) {
	if (!r) return null;
	return {
		id: r.id,
		remoteId: r.remote_id,
		stepKey: r.step_key,
		orderIndex: r.order_index,
		description: r.description,
		acceptanceCriteria: r.acceptance_criteria ?? null,
		manualReview: Boolean(r.manual_review),
		useSubagent: r.use_subagent !== 0,
		maxRetries: r.max_retries ?? 0,
		retryIntervalSeconds: r.retry_interval_seconds ?? 0,
		status: r.status ?? "pending",
		onClient: Boolean(r.on_client),
		runSelected: r.run_selected !== 0,
	};
}

function rowToCommand(r) {
	if (!r) return null;
	let payload = {};
	try {
		payload = JSON.parse(r.payload_json ?? "{}");
	} catch {
		payload = {};
	}
	return {
		id: r.id,
		clientId: r.client_id,
		remoteId: r.remote_id,
		type: r.type,
		payload,
		sequence: r.sequence,
		status: r.status,
		createdAt: r.created_at,
		ackedAt: r.acked_at,
	};
}

function rowToSyncEvent(r) {
	if (!r) return null;
	let payload = {};
	try {
		payload = JSON.parse(r.payload_json ?? "{}");
	} catch {
		payload = {};
	}
	return {
		id: r.id,
		clientId: r.client_id,
		remoteId: r.remote_id,
		type: r.type,
		payload,
		receivedAt: r.received_at,
	};
}

export function getCommandById(id) {
	return rowToCommand(open().prepare("SELECT * FROM commands WHERE id = ?").get(id));
}

/** Look up a sync client by hashed bearer token. */
export function getClientByTokenHash(tokenHash) {
	return rowToClient(open().prepare("SELECT * FROM clients WHERE token_hash = ?").get(tokenHash));
}

/** Look up a sync client by id. */
export function getClientById(id) {
	return rowToClient(open().prepare("SELECT * FROM clients WHERE id = ?").get(id));
}

/** Set local_id on a remote workflow after a successful command ack. */
export function updateRemoteWorkflowLocalId({ remoteId, clientId, localId }) {
	const info = open()
		.prepare("UPDATE remote_workflows SET local_id = ? WHERE id = ? AND client_id = ?")
		.run(localId, remoteId, clientId);
	return info.changes > 0;
}

/** Insert or update a sync client row (registration / heartbeat). */
export function upsertClient({
	id,
	name = null,
	tokenHash,
	status = "active",
	capabilities = null,
	lastSeenAt = null,
	createdAt = null,
}) {
	const now = createdAt ?? new Date().toISOString();
	const capabilitiesJson = capabilities == null ? null : JSON.stringify(capabilities);
	open()
		.prepare(
			`INSERT INTO clients (id, name, token_hash, status, capabilities_json, last_seen_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = COALESCE(excluded.name, clients.name),
			   token_hash = COALESCE(excluded.token_hash, clients.token_hash),
			   status = COALESCE(excluded.status, clients.status),
			   capabilities_json = COALESCE(excluded.capabilities_json, clients.capabilities_json),
			   last_seen_at = COALESCE(excluded.last_seen_at, clients.last_seen_at)`,
		)
		.run(id, name, tokenHash, status, capabilitiesJson, lastSeenAt ?? now, now);
	return rowToClient(open().prepare("SELECT * FROM clients WHERE id = ?").get(id));
}

/** List registered sync clients, newest first. */
export function listClients() {
	return open()
		.prepare("SELECT * FROM clients ORDER BY created_at DESC")
		.all()
		.map(rowToClient);
}

/** Default: 3× the usual 30s heartbeat interval — no heartbeat means offline. */
export const SYNC_CLIENT_ONLINE_TTL_MS = Number.parseInt(
	process.env.TARGET_SYNC_CLIENT_ONLINE_TTL_MS ?? "90000",
	10,
);

/** True when the client heartbeated recently enough to count as connected. */
export function isSyncClientOnline(client, nowMs = Date.now(), ttlMs = SYNC_CLIENT_ONLINE_TTL_MS) {
	if (!client || client.status !== "active" || !client.lastSeenAt) return false;
	const seen = Date.parse(client.lastSeenAt);
	if (!Number.isFinite(seen)) return false;
	return nowMs - seen <= ttlMs;
}

/** Clients the operator can reach right now (recent heartbeat). */
export function listOnlineClients(ttlMs = SYNC_CLIENT_ONLINE_TTL_MS) {
	const now = Date.now();
	return listClients().filter((c) => isSyncClientOnline(c, now, ttlMs));
}

export const REMOTE_RESOURCE_DOMAINS = Object.freeze(["templates", "tcp_tools", "resource_sets"]);

function assertRemoteResourceDomain(domain) {
	if (!REMOTE_RESOURCE_DOMAINS.includes(domain)) throw rbacError("invalid_resource_domain", "unknown remote resource domain");
}

function rowToRemoteResource(row) {
	if (!row) return null;
	let data = {};
	try {
		data = JSON.parse(row.resource_json);
	} catch {
		data = {};
	}
	return {
		clientId: row.client_id,
		domain: row.domain,
		id: row.resource_id,
		name: row.name,
		data,
		revision: row.revision,
		updatedAt: row.updated_at,
	};
}

/** Stable command pipeline for a client's resource domain (separate from workflows). */
export function remoteResourceChannelId(clientId, domain) {
	assertRemoteResourceDomain(domain);
	return `resources:${clientId}:${domain}`;
}

export function listRemoteResources(clientId, domain) {
	assertRemoteResourceDomain(domain);
	return open()
		.prepare("SELECT * FROM remote_resources WHERE client_id = ? AND domain = ? ORDER BY name COLLATE NOCASE, resource_id")
		.all(clientId, domain)
		.map(rowToRemoteResource);
}

export function getRemoteResource(clientId, domain, resourceId) {
	assertRemoteResourceDomain(domain);
	return rowToRemoteResource(
		open().prepare("SELECT * FROM remote_resources WHERE client_id = ? AND domain = ? AND resource_id = ?").get(clientId, domain, resourceId),
	);
}

/** Upsert is safe for retrying a client event or acknowledged command. */
export function upsertRemoteResource({ clientId, domain, resource, updatedAt = null }) {
	assertRemoteResourceDomain(domain);
	const now = updatedAt ?? new Date().toISOString();
	open()
		.prepare(
			`INSERT INTO remote_resources (client_id, domain, resource_id, name, resource_json, revision, updated_at)
			 VALUES (?, ?, ?, ?, ?, 1, ?)
			 ON CONFLICT(client_id, domain, resource_id) DO UPDATE SET
			   name = excluded.name, resource_json = excluded.resource_json,
			   revision = remote_resources.revision + 1, updated_at = excluded.updated_at`,
		)
		.run(clientId, domain, resource.id, resource.name, JSON.stringify(resource.data ?? {}), now);
	return getRemoteResource(clientId, domain, resource.id);
}

export function deleteRemoteResource(clientId, domain, resourceId) {
	assertRemoteResourceDomain(domain);
	return open()
		.prepare("DELETE FROM remote_resources WHERE client_id = ? AND domain = ? AND resource_id = ?")
		.run(clientId, domain, resourceId).changes > 0;
}

/** Enqueue a command for a client; sequence is per remote_id. */
export function enqueueCommand({
	id = null,
	clientId,
	remoteId = null,
	type,
	payload = {},
	createdAt = null,
}) {
	const v = validateCommand(type, payload);
	if (!v.ok) {
		const err = new Error("invalid command payload");
		err.statusCode = 400;
		err.errors = v.errors;
		throw err;
	}
	const db = open();
	const commandId = id ?? randomUUID();
	const now = createdAt ?? new Date().toISOString();
	const validatedPayload = v.value;
	db.exec("BEGIN IMMEDIATE");
	try {
		const maxRow = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS mx FROM commands WHERE remote_id = ?").get(remoteId);
		const sequence = (maxRow?.mx ?? 0) + 1;
		db.prepare(
			`INSERT INTO commands (id, client_id, remote_id, type, payload_json, sequence, status, created_at, acked_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
		).run(commandId, clientId, remoteId, type, JSON.stringify(validatedPayload), sequence, now);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
	return getCommandById(commandId);
}

/**
 * Claim pending commands for a client (pending → delivered).
 * Per remote_id, only the lowest pending sequence is claimable once prior
 * commands in that pipeline are acked or failed.
 */
export function claimPendingCommands(clientId, { limit = 10 } = {}) {
	const db = open();
	const claimed = [];
	db.exec("BEGIN IMMEDIATE");
	try {
		const pending = db
			.prepare(
				`SELECT * FROM commands
				 WHERE client_id = ? AND status = 'pending'
				 ORDER BY created_at ASC, sequence ASC`,
			)
			.all(clientId);
		const canClaim = db.prepare(
			`SELECT status FROM commands WHERE remote_id = ? AND sequence = ? LIMIT 1`,
		);
		const markDelivered = db.prepare(
			`UPDATE commands SET status = 'delivered' WHERE id = ? AND status = 'pending'`,
		);
		for (const row of pending) {
			if (claimed.length >= limit) break;
			if (row.sequence > 1 && row.remote_id) {
				const prev = canClaim.get(row.remote_id, row.sequence - 1);
				if (!prev || (prev.status !== "acked" && prev.status !== "failed")) continue;
			}
			const info = markDelivered.run(row.id);
			if (info.changes > 0) {
				claimed.push(rowToCommand({ ...row, status: "delivered" }));
			}
		}
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
	return claimed;
}

/** Acknowledge a delivered command (delivered → acked | failed). */
export function ackCommand({ commandId, clientId, status, ackedAt = null }) {
	if (status !== "acked" && status !== "failed") {
		throw new Error("ack status must be acked or failed");
	}
	const now = ackedAt ?? new Date().toISOString();
	const info = open()
		.prepare(
			`UPDATE commands
			 SET status = ?, acked_at = ?
			 WHERE id = ? AND client_id = ? AND status IN ('delivered', 'pending')`,
		)
		.run(status, now, commandId, clientId);
	if (info.changes === 0) {
		const existing = getCommandById(commandId);
		if (existing?.clientId === clientId && (existing.status === "acked" || existing.status === "failed")) {
			return { ok: true, alreadyRecorded: true, command: existing };
		}
		return { ok: false, alreadyRecorded: false, command: existing };
	}
	return { ok: true, alreadyRecorded: false, command: getCommandById(commandId) };
}

/** Insert a sync event idempotently by event id. Returns inserted | duplicate. */
export function insertSyncEvent({
	id,
	clientId,
	remoteId = null,
	type,
	payload = {},
	receivedAt = null,
}) {
	const now = receivedAt ?? new Date().toISOString();
	const info = open()
		.prepare(
			`INSERT OR IGNORE INTO sync_events (id, client_id, remote_id, type, payload_json, received_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(id, clientId, remoteId, type, JSON.stringify(payload), now);
	return info.changes > 0 ? "inserted" : "duplicate";
}

/** Look up a remote workflow by id. */
export function getRemoteWorkflowById(id) {
	return rowToRemoteWorkflow(open().prepare("SELECT * FROM remote_workflows WHERE id = ?").get(id));
}

/** Insert a remote workflow row. */
export function createRemoteWorkflow({
	id = null,
	clientId,
	name,
	status = "pending",
	conversationContext = null,
	sandbox = "docker",
	agent = null,
	createdAt = null,
}) {
	const remoteId = id ?? randomUUID();
	const now = createdAt ?? new Date().toISOString();
	open()
		.prepare(
			`INSERT INTO remote_workflows (id, client_id, name, status, local_id, conversation_context, sandbox, agent, created_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
		)
		.run(remoteId, clientId, name, status, conversationContext, sandbox, agent, now);
	return getRemoteWorkflowById(remoteId);
}

/** Update conversation context on a remote workflow (server-side plan). */
export function updateRemoteWorkflowContext(id, conversationContext) {
	const info = open()
		.prepare("UPDATE remote_workflows SET conversation_context = ? WHERE id = ?")
		.run(conversationContext, id);
	return info.changes > 0 ? getRemoteWorkflowById(id) : null;
}

/** Count task steps planned for a remote workflow. */
export function countRemoteSteps(remoteId) {
	const row = open()
		.prepare("SELECT COUNT(*) AS n FROM remote_workflow_steps WHERE remote_id = ?")
		.get(remoteId);
	return row?.n ?? 0;
}

/** Mark a mirrored step as present on the client (command acked). */
export function markRemoteStepOnClient(remoteId, stepKey) {
	if (!remoteId || !stepKey) return false;
	const info = open()
		.prepare("UPDATE remote_workflow_steps SET on_client = 1 WHERE remote_id = ? AND step_key = ?")
		.run(remoteId, stepKey);
	return info.changes > 0;
}

/** Mark a step as waiting for the client to apply a pending change. */
export function markRemoteStepPendingSync(remoteId, stepKey) {
	if (!remoteId || !stepKey) return false;
	const info = open()
		.prepare("UPDATE remote_workflow_steps SET on_client = 0 WHERE remote_id = ? AND step_key = ?")
		.run(remoteId, stepKey);
	return info.changes > 0;
}

/** Reconcile on_client from command queue (acked vs in-flight). */
export function refreshRemoteStepClientSync(remoteId) {
	const db = open();
	db.prepare(
		`UPDATE remote_workflow_steps SET on_client = 1
		 WHERE remote_id = ?
		   AND step_key IN (
		     SELECT json_extract(payload_json, '$.step_key')
		     FROM commands
		     WHERE remote_id = ? AND type IN ('step.add', 'step.edit') AND status = 'acked'
		   )`,
	).run(remoteId, remoteId);
	db.prepare(
		`UPDATE remote_workflow_steps SET on_client = 0
		 WHERE remote_id = ?
		   AND step_key IN (
		     SELECT json_extract(payload_json, '$.step_key')
		     FROM commands
		     WHERE remote_id = ? AND type IN ('step.add', 'step.edit') AND status IN ('pending', 'delivered')
		   )`,
	).run(remoteId, remoteId);
}

/** Drop a remote workflow row and its mirrored plan after the client confirms delete. */
export function removeRemoteWorkflow(remoteId) {
	const db = open();
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare("DELETE FROM remote_workflow_steps WHERE remote_id = ?").run(remoteId);
		db.prepare("DELETE FROM remote_workflows WHERE id = ?").run(remoteId);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
	return true;
}

function isRemoteWorkflowAlreadyGoneError(message) {
	if (typeof message !== "string" || !message) return false;
	return /not mapped locally|unknown workflow/i.test(message);
}

function revertRemoteWorkflowDeleteState(remoteId) {
	const workflow = getRemoteWorkflowById(remoteId);
	if (!workflow || workflow.status !== "deleting") return;
	const steps = listRemoteSteps(remoteId);
	const allDone =
		steps.length > 0 &&
		steps.every((s) => s.status === "done" || s.status === "completed" || s.status === "failed");
	updateRemoteWorkflowStatus(remoteId, allDone ? "completed" : "draft");
}

/** Remove or revert remote workflows stuck in deleting after the delete command finished. */
export function reconcileStuckDeletingRemoteWorkflows() {
	const db = open();
	const acked = db
		.prepare(
			`SELECT rw.id FROM remote_workflows rw
			 WHERE rw.status = 'deleting'
			   AND EXISTS (
			     SELECT 1 FROM commands c
			     WHERE c.remote_id = rw.id AND c.type = 'workflow.delete' AND c.status = 'acked'
			   )`,
		)
		.all();
	for (const row of acked) removeRemoteWorkflow(row.id);

	const failed = db
		.prepare(
			`SELECT rw.id FROM remote_workflows rw
			 WHERE rw.status = 'deleting'
			   AND EXISTS (
			     SELECT 1 FROM commands c
			     WHERE c.remote_id = rw.id AND c.type = 'workflow.delete' AND c.status = 'failed'
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM commands c
			     WHERE c.remote_id = rw.id AND c.type = 'workflow.delete'
			       AND c.status IN ('pending', 'delivered')
			   )`,
		)
		.all();
	for (const row of failed) {
		const latestFail = db
			.prepare(
				`SELECT payload_json FROM sync_events
				 WHERE remote_id = ? AND type = 'command.ack'
				 ORDER BY received_at DESC LIMIT 30`,
			)
			.all(row.id)
			.map((r) => {
				try {
					return JSON.parse(r.payload_json ?? "{}");
				} catch {
					return {};
				}
			})
			.find((p) => p.status === "failed" && isRemoteWorkflowAlreadyGoneError(p.error?.message));
		if (latestFail) removeRemoteWorkflow(row.id);
		else revertRemoteWorkflowDeleteState(row.id);
	}
}

/** After a command finishes on the client, update the server-side plan mirror. */
export function applyCommandAckToPlan(command) {
	if (!command?.remoteId) return;
	if (command.type === "workflow.delete") {
		if (command.status === "acked") {
			removeRemoteWorkflow(command.remoteId);
			return;
		}
		if (command.status === "failed") {
			if (isRemoteWorkflowAlreadyGoneError(command.ackError)) {
				removeRemoteWorkflow(command.remoteId);
				return;
			}
			revertRemoteWorkflowDeleteState(command.remoteId);
			return;
		}
	}
	if (command.status !== "acked") return;
	if (command.type === "step.add" || command.type === "step.edit") {
		const stepKey = command.payload?.step_key;
		if (typeof stepKey === "string" && stepKey) markRemoteStepOnClient(command.remoteId, stepKey);
	}
}

/** List planned steps for a remote workflow in run order. */
export function listRemoteSteps(remoteId) {
	refreshRemoteStepClientSync(remoteId);
	return open()
		.prepare("SELECT * FROM remote_workflow_steps WHERE remote_id = ? ORDER BY order_index ASC, step_key ASC")
		.all(remoteId)
		.map(rowToRemoteStep);
}

/** Insert or replace a planned step row (operator plan mirror). */
export function upsertRemoteStep({
	remoteId,
	stepKey,
	orderIndex,
	description,
	acceptanceCriteria = null,
	manualReview = false,
	useSubagent = true,
	maxRetries = 0,
	retryIntervalSeconds = 0,
	status = "pending",
}) {
	const id = randomUUID();
	open()
		.prepare(
			`INSERT INTO remote_workflow_steps
			 (id, remote_id, step_key, order_index, description, acceptance_criteria, manual_review, use_subagent, max_retries, retry_interval_seconds, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(remote_id, step_key) DO UPDATE SET
			   order_index = excluded.order_index,
			   description = excluded.description,
			   acceptance_criteria = excluded.acceptance_criteria,
			   manual_review = excluded.manual_review,
			   use_subagent = excluded.use_subagent,
			   max_retries = excluded.max_retries,
			   retry_interval_seconds = excluded.retry_interval_seconds,
			   status = COALESCE(excluded.status, remote_workflow_steps.status)`,
		)
		.run(
			id,
			remoteId,
			stepKey,
			orderIndex,
			description,
			acceptanceCriteria,
			manualReview ? 1 : 0,
			useSubagent ? 1 : 0,
			maxRetries,
			retryIntervalSeconds,
			status,
		);
	return open()
		.prepare("SELECT * FROM remote_workflow_steps WHERE remote_id = ? AND step_key = ?")
		.get(remoteId, stepKey);
}

/** Remove a planned step. */
export function deleteRemoteStep(remoteId, stepKey) {
	const info = open()
		.prepare("DELETE FROM remote_workflow_steps WHERE remote_id = ? AND step_key = ?")
		.run(remoteId, stepKey);
	return info.changes > 0;
}

/** Update step status from client events. */
export function updateRemoteStepStatus(remoteId, stepKey, status) {
	const info = open()
		.prepare("UPDATE remote_workflow_steps SET status = ? WHERE remote_id = ? AND step_key = ?")
		.run(status, remoteId, stepKey);
	return info.changes > 0;
}

/** Reorder a step and compact order_index for siblings. */
export function moveRemoteStep(remoteId, stepKey, toIndex) {
	const db = open();
	const steps = listRemoteSteps(remoteId);
	const current = steps.find((s) => s.stepKey === stepKey);
	if (!current) return false;
	const without = steps.filter((s) => s.stepKey !== stepKey);
	const clamped = Math.max(0, Math.min(toIndex, without.length));
	without.splice(clamped, 0, current);
	db.exec("BEGIN IMMEDIATE");
	try {
		for (let i = 0; i < without.length; i++) {
			db.prepare("UPDATE remote_workflow_steps SET order_index = ? WHERE remote_id = ? AND step_key = ?").run(
				i,
				remoteId,
				without[i].stepKey,
			);
		}
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
	return true;
}

/** Mirror an enqueued command into the server-side plan (best-effort). */
export function mirrorCommandToPlan({ remoteId, type, payload = {} }) {
	if (!remoteId) return;
	if (type === "step.add") {
		const stepKey = String(payload.step_key ?? "");
		const description = String(payload.description ?? "");
		if (!stepKey || !description.trim()) return;
		const orderIndex =
			typeof payload.order_index === "number" ? payload.order_index : countRemoteSteps(remoteId);
		upsertRemoteStep({
			remoteId,
			stepKey,
			orderIndex,
			description,
			acceptanceCriteria: payload.acceptance_criteria?.trim() || null,
			manualReview: payload.manual_review === true,
			useSubagent: payload.use_subagent !== false,
			maxRetries: payload.max_retries ?? 0,
			retryIntervalSeconds: payload.retry_interval_seconds ?? 0,
		});
		return;
	}
	if (type === "step.edit") {
		const stepKey = String(payload.step_key ?? "");
		if (!stepKey) return;
		markRemoteStepPendingSync(remoteId, stepKey);
		const existing = open()
			.prepare("SELECT * FROM remote_workflow_steps WHERE remote_id = ? AND step_key = ?")
			.get(remoteId, stepKey);
		if (!existing) return;
		upsertRemoteStep({
			remoteId,
			stepKey,
			orderIndex: existing.order_index,
			description: typeof payload.description === "string" ? payload.description : existing.description,
			acceptanceCriteria:
				typeof payload.acceptance_criteria === "string"
					? payload.acceptance_criteria || null
					: existing.acceptance_criteria,
			manualReview:
				typeof payload.manual_review === "boolean" ? payload.manual_review : Boolean(existing.manual_review),
			useSubagent:
				typeof payload.use_subagent === "boolean" ? payload.use_subagent : existing.use_subagent !== 0,
			maxRetries: typeof payload.max_retries === "number" ? payload.max_retries : existing.max_retries,
			retryIntervalSeconds:
				typeof payload.retry_interval_seconds === "number"
					? payload.retry_interval_seconds
					: existing.retry_interval_seconds,
			status: existing.status,
		});
		return;
	}
	if (type === "step.remove") {
		deleteRemoteStep(remoteId, String(payload.step_key ?? ""));
		return;
	}
	if (type === "step.move") {
		moveRemoteStep(remoteId, String(payload.step_key ?? ""), payload.to_index ?? 0);
	}
}

/** Apply client sync events to the mirrored plan (status only). */
export function mirrorSyncEventToPlan({ remoteId, type, payload = {} }) {
	if (!remoteId) return;
	if (type === "workflow.status_changed" && typeof payload.to === "string") {
		const workflow = getRemoteWorkflowById(remoteId);
		if (workflow?.status === "deleting") return;
		updateRemoteWorkflowStatus(remoteId, payload.to);
		return;
	}
	if (type === "step.status_changed") {
		const stepKey = String(payload.step_key ?? "");
		const to = String(payload.to ?? "");
		if (stepKey && to) {
			updateRemoteStepStatus(remoteId, stepKey, to);
			markRemoteStepOnClient(remoteId, stepKey);
		}
		return;
	}
	if (type === "command.ack" && typeof payload.command_id === "string") {
		const command = getCommandById(payload.command_id);
		if (!command) return;
		const status = payload.status === "acked" ? "acked" : payload.status === "failed" ? "failed" : null;
		if (!status) return;
		applyCommandAckToPlan({
			...command,
			status,
			ackError: typeof payload.error?.message === "string" ? payload.error.message : undefined,
		});
	}
}

/** Apply a client resource event after `sync_events` has accepted its event id. */
export function mirrorResourceSyncEvent({ clientId, type, payload = {} }) {
	const match = /^(template|tcp-tool|resource-set)\.(upserted|deleted)$/.exec(type);
	if (!match) return false;
	const domain = { template: "templates", "tcp-tool": "tcp_tools", "resource-set": "resource_sets" }[match[1]];
	if (match[2] === "upserted" && payload.resource?.id && payload.resource?.name) {
		upsertRemoteResource({ clientId, domain, resource: payload.resource });
		return true;
	}
	if (match[2] === "deleted" && typeof payload.resource_id === "string") {
		deleteRemoteResource(clientId, domain, payload.resource_id);
		return true;
	}
	return false;
}

/** Update remote workflow status. Returns updated row or null if not found. */
export function updateRemoteWorkflowStatus(id, status) {
	const info = open().prepare("UPDATE remote_workflows SET status = ? WHERE id = ?").run(status, id);
	return info.changes > 0 ? getRemoteWorkflowById(id) : null;
}

/** List sync events, newest first. */
export function listSyncEvents({ clientId = null, remoteId = null, limit = 50 } = {}) {
	const lim = Math.min(200, Math.max(1, limit));
	const clauses = [];
	const params = [];
	if (clientId) {
		clauses.push("client_id = ?");
		params.push(clientId);
	}
	if (remoteId) {
		clauses.push("remote_id = ?");
		params.push(remoteId);
	}
	let sql = "SELECT * FROM sync_events";
	if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
	sql += " ORDER BY received_at DESC LIMIT ?";
	params.push(lim);
	return open()
		.prepare(sql)
		.all(...params)
		.map(rowToSyncEvent);
}

/** Step keys the operator marked to run on the next start/resume/restart. */
export function getRunSelectedStepKeys(remoteId) {
	return open()
		.prepare(
			`SELECT step_key FROM remote_workflow_steps
			 WHERE remote_id = ? AND run_selected = 1
			 ORDER BY order_index ASC, step_key ASC`,
		)
		.all(remoteId)
		.map((row) => row.step_key);
}

/** Persist which planned steps the operator wants to run. */
export function updateRemoteStepRunSelection(remoteId, stepKeys) {
	const selected = new Set(stepKeys);
	const rows = open()
		.prepare("SELECT step_key FROM remote_workflow_steps WHERE remote_id = ?")
		.all(remoteId);
	const db = open();
	for (const row of rows) {
		db.prepare("UPDATE remote_workflow_steps SET run_selected = ? WHERE remote_id = ? AND step_key = ?").run(
			selected.has(row.step_key) ? 1 : 0,
			remoteId,
			row.step_key,
		);
	}
	return getRunSelectedStepKeys(remoteId);
}

/** Count mirrored steps not yet confirmed on the client. */
export function countStepsPendingSync(remoteId) {
	refreshRemoteStepClientSync(remoteId);
	const row = open()
		.prepare("SELECT COUNT(*) AS n FROM remote_workflow_steps WHERE remote_id = ? AND on_client = 0")
		.get(remoteId);
	return row?.n ?? 0;
}

/** List remote workflows, optionally filtered by client. */
export function listRemoteWorkflows({ clientId = null } = {}) {
	reconcileStuckDeletingRemoteWorkflows();
	const sql = clientId
		? `SELECT rw.*, (SELECT COUNT(*) FROM remote_workflow_steps rs WHERE rs.remote_id = rw.id) AS step_count
		   FROM remote_workflows rw WHERE rw.client_id = ? ORDER BY rw.created_at DESC`
		: `SELECT rw.*, (SELECT COUNT(*) FROM remote_workflow_steps rs WHERE rs.remote_id = rw.id) AS step_count
		   FROM remote_workflows rw ORDER BY rw.created_at DESC`;
	const rows = clientId ? open().prepare(sql).all(clientId) : open().prepare(sql).all();
	for (const row of rows) refreshRemoteStepClientSync(row.id);
	const pendingByRemote = open()
		.prepare(
			`SELECT remote_id, COUNT(*) AS steps_pending_sync
			 FROM remote_workflow_steps WHERE on_client = 0 GROUP BY remote_id`,
		)
		.all();
	const pendingMap = Object.fromEntries(pendingByRemote.map((p) => [p.remote_id, p.steps_pending_sync]));
	return rows.map((row) =>
		rowToRemoteWorkflow({ ...row, steps_pending_sync: pendingMap[row.id] ?? 0 }),
	);
}

/** Commands waiting for the client to poll or ack. */
export function listInFlightCommands(remoteId) {
	return open()
		.prepare(
			`SELECT * FROM commands
			 WHERE remote_id = ? AND status IN ('pending', 'delivered')
			 ORDER BY sequence ASC`,
		)
		.all(remoteId)
		.map(rowToCommand);
}

/** Remote workflow with its planned steps (operator detail view). */
export function getRemoteWorkflowDetail(id) {
	const workflow = getRemoteWorkflowById(id);
	if (!workflow) return null;
	const steps = listRemoteSteps(id);
	return {
		workflow: { ...workflow, stepCount: steps.length, stepsPendingSync: steps.filter((s) => !s.onClient).length },
		steps,
		pendingCommands: listInFlightCommands(id),
	};
}
