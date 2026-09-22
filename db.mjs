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
 * Presentation groups for the closed RBAC catalogue. Session/UI code should
 * read `getPermissionCatalog()` rather than inventing a second vocabulary.
 */
export const PERMISSION_GROUPS = Object.freeze([
	{ id: "server.activity", scope: "server", label: "Activity", description: "View reporting data on this dashboard server" },
	{ id: "server.users", scope: "server", label: "Users", description: "View and manage dashboard accounts and roles" },
	{ id: "server.devices", scope: "server", label: "Devices", description: "Approve and manage linked Target hubs" },
	{ id: "server.templates", scope: "server", label: "Templates", description: "Manage workflow templates stored on this dashboard server" },
	{ id: "server.tcp", scope: "server", label: "TCP tools", description: "Manage TCP packs stored on this dashboard server" },
	{ id: "server.rci", scope: "server", label: "RCI", description: "Manage RCI resource sets stored on this dashboard server" },
	{ id: "client.remote", scope: "client", label: "Remote Control", description: "View connected Target hubs and their remote state" },
	{ id: "client.workflows", scope: "client", label: "Workflows", description: "Create, edit and run workflows on a connected Target hub" },
	{ id: "client.templates", scope: "client", label: "Templates", description: "Manage templates on a connected Target hub" },
	{ id: "client.tcp", scope: "client", label: "TCP tools", description: "Manage TCP tools on a connected Target hub" },
	{ id: "client.rci", scope: "client", label: "RCI", description: "Manage RCI resource sets on a connected Target hub" },
]);

/**
 * The complete RBAC vocabulary. This is the single application catalogue:
 * checks and role writes must use these IDs rather than client-supplied
 * capability strings. Every entry carries a server|client scope and a group.
 */
export const PERMISSION_CATALOG = Object.freeze([
	{ id: "activity.read", label: "View Activity", description: "View Activity and reporting data", scope: "server", group: "server.activity" },
	{ id: "users.read", label: "View users", description: "View users, roles and invitations", scope: "server", group: "server.users" },
	{ id: "users.manage", label: "Manage users and roles", description: "Manage users, roles and invitations", scope: "server", group: "server.users" },
	{ id: "devices.link", label: "Approve or deny device-link requests", description: "Approve or deny device-link requests", scope: "server", group: "server.devices" },
	{ id: "devices.manage", label: "Manage linked devices", description: "List, rotate and revoke linked devices", scope: "server", group: "server.devices" },
	{ id: "templates.read", label: "View templates", description: "View workflow templates stored on this server", scope: "server", group: "server.templates" },
	{ id: "templates.create", label: "Create templates", description: "Create workflow templates stored on this server", scope: "server", group: "server.templates" },
	{ id: "templates.edit", label: "Edit templates", description: "Edit workflow templates stored on this server", scope: "server", group: "server.templates" },
	{ id: "templates.delete", label: "Delete templates", description: "Delete workflow templates stored on this server", scope: "server", group: "server.templates" },
	{ id: "templates.import", label: "Import templates", description: "Import workflow templates stored on this server", scope: "server", group: "server.templates" },
	{ id: "templates.export", label: "Export templates", description: "Export workflow templates stored on this server", scope: "server", group: "server.templates" },
	{ id: "tcp-tools.read", label: "View TCP tools", description: "View TCP packs stored on this server", scope: "server", group: "server.tcp" },
	{ id: "tcp-tools.create", label: "Create TCP tools", description: "Create TCP packs stored on this server", scope: "server", group: "server.tcp" },
	{ id: "tcp-tools.edit", label: "Edit TCP tools", description: "Edit TCP packs stored on this server", scope: "server", group: "server.tcp" },
	{ id: "tcp-tools.delete", label: "Delete TCP tools", description: "Delete TCP packs stored on this server", scope: "server", group: "server.tcp" },
	{ id: "tcp-tools.import", label: "Import TCP tools", description: "Import TCP packs stored on this server", scope: "server", group: "server.tcp" },
	{ id: "tcp-tools.export", label: "Export TCP tools", description: "Export TCP packs stored on this server", scope: "server", group: "server.tcp" },
	{ id: "rci.read", label: "View RCI resources", description: "View RCI resource sets stored on this server", scope: "server", group: "server.rci" },
	{ id: "rci.create", label: "Create RCI resources", description: "Create RCI resource sets stored on this server", scope: "server", group: "server.rci" },
	{ id: "rci.edit", label: "Edit RCI resources", description: "Edit RCI resource sets stored on this server", scope: "server", group: "server.rci" },
	{ id: "rci.delete", label: "Delete RCI resources", description: "Delete RCI resource sets stored on this server", scope: "server", group: "server.rci" },
	{ id: "rci.import", label: "Import RCI resources", description: "Import RCI resource sets stored on this server", scope: "server", group: "server.rci" },
	{ id: "rci.export", label: "Export RCI resources", description: "Export RCI resource sets stored on this server", scope: "server", group: "server.rci" },
	{ id: "remote.read", label: "View Remote Control", description: "View Remote Control clients and state", scope: "client", group: "client.remote" },
	{ id: "remote.workflows.create", label: "Create workflows", description: "Create remote workflows", scope: "client", group: "client.workflows" },
	{ id: "remote.workflows.steps.add", label: "Add workflow steps", description: "Add steps to remote workflows", scope: "client", group: "client.workflows" },
	{ id: "remote.workflows.steps.edit", label: "Edit workflow steps", description: "Edit steps on remote workflows", scope: "client", group: "client.workflows" },
	{ id: "remote.workflows.manage", label: "Manage remote workflows", description: "Delete remote workflows, set conversation context and choose run selection", scope: "client", group: "client.workflows" },
	{ id: "remote.workflows.execute", label: "Execute remote workflows", description: "Start, pause, resume and restart remote workflows", scope: "client", group: "client.workflows" },
	{ id: "remote.templates.create", label: "Create templates", description: "Create remote workflow templates", scope: "client", group: "client.templates" },
	{ id: "remote.templates.edit", label: "Edit templates", description: "Edit remote workflow templates", scope: "client", group: "client.templates" },
	{ id: "remote.templates.delete", label: "Delete templates", description: "Delete remote workflow templates", scope: "client", group: "client.templates" },
	{ id: "remote.templates.import", label: "Import templates", description: "Import remote workflow templates", scope: "client", group: "client.templates" },
	{ id: "remote.templates.export", label: "Export templates", description: "Export remote workflow templates", scope: "client", group: "client.templates" },
	{ id: "remote.tcp-tools.create", label: "Create TCP tools", description: "Create remote TCP tools", scope: "client", group: "client.tcp" },
	{ id: "remote.tcp-tools.edit", label: "Edit TCP tools", description: "Edit remote TCP tools", scope: "client", group: "client.tcp" },
	{ id: "remote.tcp-tools.delete", label: "Delete TCP tools", description: "Delete remote TCP tools", scope: "client", group: "client.tcp" },
	{ id: "remote.tcp-tools.import", label: "Import TCP tools", description: "Import remote TCP tools", scope: "client", group: "client.tcp" },
	{ id: "remote.tcp-tools.export", label: "Export TCP tools", description: "Export remote TCP tools", scope: "client", group: "client.tcp" },
	{ id: "remote.rci.create", label: "Create RCI resources", description: "Create remote RCI resources", scope: "client", group: "client.rci" },
	{ id: "remote.rci.edit", label: "Edit RCI resources", description: "Edit remote RCI resources", scope: "client", group: "client.rci" },
	{ id: "remote.rci.delete", label: "Delete RCI resources", description: "Delete remote RCI resources", scope: "client", group: "client.rci" },
	{ id: "remote.rci.import", label: "Import RCI resources", description: "Import remote RCI resources", scope: "client", group: "client.rci" },
	{ id: "remote.rci.export", label: "Export RCI resources", description: "Export remote RCI resources", scope: "client", group: "client.rci" },
]);
export const PERMISSIONS = Object.freeze(PERMISSION_CATALOG.map(({ id }) => id));
export const ADMIN_ROLE_ID = "admin";
const PERMISSION_SET = new Set(PERMISSIONS);

/** Retired resource-level IDs expanded into per-action children on open. */
const LEGACY_RESOURCE_PERMISSIONS = Object.freeze({
	"remote.templates.manage": [
		"remote.templates.create",
		"remote.templates.edit",
		"remote.templates.delete",
		"remote.templates.import",
		"remote.templates.export",
	],
	"remote.tcp-tools.manage": [
		"remote.tcp-tools.create",
		"remote.tcp-tools.edit",
		"remote.tcp-tools.delete",
		"remote.tcp-tools.import",
		"remote.tcp-tools.export",
	],
	"remote.rci.manage": [
		"remote.rci.create",
		"remote.rci.edit",
		"remote.rci.delete",
		"remote.rci.import",
		"remote.rci.export",
	],
});
const REMOVED_PERMISSIONS = Object.freeze(Object.keys(LEGACY_RESOURCE_PERMISSIONS));
const WORKFLOW_MANAGE_GRANTS = Object.freeze([
	"remote.workflows.create",
	"remote.workflows.steps.add",
	"remote.workflows.steps.edit",
]);

const PERMISSION_CATALOG_VIEW = Object.freeze({
	groups: Object.freeze(
		PERMISSION_GROUPS.map((group) =>
			Object.freeze({
				id: group.id,
				scope: group.scope,
				label: group.label,
				description: group.description,
				permissions: Object.freeze(
					PERMISSION_CATALOG.filter((entry) => entry.group === group.id).map((entry) =>
						Object.freeze({
							id: entry.id,
							label: entry.label,
							description: entry.description,
						}),
					),
				),
			}),
		),
	),
});

/** Closed catalogue grouped by scope for session and UI rendering. */
export function getPermissionCatalog() {
	return PERMISSION_CATALOG_VIEW;
}

function permissionCheckValues() {
	return PERMISSIONS.map((permission) => `'${permission}'`).join(", ");
}

function expandStoredPermission(permission) {
	if (Object.hasOwn(LEGACY_RESOURCE_PERMISSIONS, permission)) return LEGACY_RESOURCE_PERMISSIONS[permission];
	return PERMISSION_SET.has(permission) ? [permission] : [];
}

export const DEVICE_SCOPES = Object.freeze(["ingest:write", "sync:write"]);
const DEVICE_SCOPE_SET = new Set(DEVICE_SCOPES);

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
	migrateDeviceLinkSchema(db);
	migrateCatalogSchema(db);
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

/** Additive server-owned catalog: templates, TCP packs, and RCI resource sets. */
function migrateCatalogSchema(database) {
	database.exec(`
		CREATE TABLE IF NOT EXISTS templates (
			id          TEXT PRIMARY KEY,
			name        TEXT NOT NULL,
			tags        TEXT NOT NULL DEFAULT '[]',
			payload     TEXT NOT NULL DEFAULT '{}',
			created_at  TEXT NOT NULL,
			updated_at  TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS tcps (
			id          TEXT PRIMARY KEY,
			name        TEXT NOT NULL,
			tags        TEXT NOT NULL DEFAULT '[]',
			payload     TEXT NOT NULL DEFAULT '{}',
			created_at  TEXT NOT NULL,
			updated_at  TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS resource_sets (
			id          TEXT PRIMARY KEY,
			name        TEXT NOT NULL,
			tags        TEXT NOT NULL DEFAULT '[]',
			payload     TEXT NOT NULL DEFAULT '{}',
			created_at  TEXT NOT NULL,
			updated_at  TEXT NOT NULL
		);
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
				permission  TEXT NOT NULL CHECK (permission IN (${permissionCheckValues()})),
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
		ensureRbacPermissionConstraint(database);
		migrateLegacyRbacPermissions(database);
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

/**
 * SQLite cannot widen a CHECK constraint in place. Rebuild the small
 * relation whenever its allowed list does not contain every current
 * PERMISSIONS id (or still lists a retired resource-level id). Existing
 * rows are remapped before the new CHECK is applied so a naive copy of
 * `remote.*.manage` cannot fail the insert.
 */
function ensureRbacPermissionConstraint(database) {
	const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auth_role_permissions'").get();
	const sql = row?.sql ?? "";
	const missingCurrent = PERMISSIONS.some((permission) => !sql.includes(`'${permission}'`));
	const listsRemoved = REMOVED_PERMISSIONS.some((permission) => sql.includes(`'${permission}'`));
	if (!missingCurrent && !listsRemoved) return;
	const existing = database.prepare("SELECT role_id, permission FROM auth_role_permissions").all();
	const values = permissionCheckValues();
	database.exec(`
		CREATE TABLE auth_role_permissions_next (
			role_id     TEXT NOT NULL,
			permission  TEXT NOT NULL CHECK (permission IN (${values})),
			PRIMARY KEY (role_id, permission)
		);
	`);
	const insert = database.prepare(
		"INSERT OR IGNORE INTO auth_role_permissions_next (role_id, permission) VALUES (?, ?)",
	);
	for (const { role_id, permission } of existing) {
		for (const mapped of expandStoredPermission(permission)) insert.run(role_id, mapped);
	}
	database.exec(`
		DROP TABLE auth_role_permissions;
		ALTER TABLE auth_role_permissions_next RENAME TO auth_role_permissions;
		CREATE INDEX IF NOT EXISTS idx_auth_role_permissions_role
			ON auth_role_permissions(role_id);
	`);
}

/**
 * Additive data migration: expand retired resource `*.manage` rows into the
 * five action IDs, then grant create/step abilities to roles that already
 * had `remote.workflows.manage`. Safe to repeat.
 */
function migrateLegacyRbacPermissions(database) {
	const insert = database.prepare(
		"INSERT OR IGNORE INTO auth_role_permissions (role_id, permission) VALUES (?, ?)",
	);
	const remove = database.prepare(
		"DELETE FROM auth_role_permissions WHERE role_id = ? AND permission = ?",
	);
	for (const [legacy, children] of Object.entries(LEGACY_RESOURCE_PERMISSIONS)) {
		const rows = database.prepare("SELECT role_id FROM auth_role_permissions WHERE permission = ?").all(legacy);
		for (const { role_id } of rows) {
			for (const child of children) insert.run(role_id, child);
			remove.run(role_id, legacy);
		}
	}
	const workflowRoles = database
		.prepare("SELECT role_id FROM auth_role_permissions WHERE permission = 'remote.workflows.manage'")
		.all();
	for (const { role_id } of workflowRoles) {
		for (const child of WORKFLOW_MANAGE_GRANTS) insert.run(role_id, child);
	}
}

/** Additive schema for the device-link/v1 identity and pairing lifecycle. */
function migrateDeviceLinkSchema(database) {
	const addColumn = (table, name, ddl) => {
		try {
			database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
		} catch {
			// Existing installations already have the column.
		}
	};
	// Attribution is additive: legacy report/sync rows retain NULL device fields.
	addColumn("instances", "device_id", "TEXT");
	addColumn("instances", "owner_user_id", "TEXT");
	addColumn("events", "device_id", "TEXT");
	addColumn("events", "owner_user_id", "TEXT");
	addColumn("clients", "device_id", "TEXT");
	addColumn("clients", "owner_user_id", "TEXT");
	addColumn("sync_events", "device_id", "TEXT");
	addColumn("sync_events", "owner_user_id", "TEXT");
	database.exec(`
		CREATE TABLE IF NOT EXISTS linked_devices (
			id                 TEXT PRIMARY KEY,
			owner_user_id      TEXT NOT NULL REFERENCES auth_users(id),
			name               TEXT NOT NULL,
			hub_version        TEXT,
			public_key         TEXT NOT NULL,
			scopes_json        TEXT NOT NULL,
			status             TEXT NOT NULL CHECK (status IN ('active', 'rotating', 'revoked')),
			credential_version INTEGER NOT NULL DEFAULT 1,
			created_at         TEXT NOT NULL,
			updated_at         TEXT NOT NULL,
			last_used_at       TEXT,
			revoked_at         TEXT,
			revoked_by_user_id TEXT REFERENCES auth_users(id),
			revocation_reason  TEXT
		);
		CREATE TABLE IF NOT EXISTS device_credentials (
			device_id    TEXT NOT NULL REFERENCES linked_devices(id),
			version      INTEGER NOT NULL,
			secret_hash  TEXT NOT NULL UNIQUE,
			issued_at    TEXT NOT NULL,
			expires_at   TEXT,
			revoked_at   TEXT,
			PRIMARY KEY (device_id, version)
		);
		CREATE TABLE IF NOT EXISTS device_link_requests (
			id                       TEXT PRIMARY KEY,
			idempotency_key          TEXT UNIQUE,
			idempotency_fingerprint  TEXT,
			device_name              TEXT NOT NULL,
			hub_version              TEXT,
			public_key               TEXT NOT NULL,
			scopes_json              TEXT NOT NULL,
			polling_credential_hash  TEXT NOT NULL UNIQUE,
			owner_user_id            TEXT REFERENCES auth_users(id),
			status                   TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
			created_at               TEXT NOT NULL,
			expires_at               TEXT NOT NULL,
			decided_at               TEXT,
			consumed_at              TEXT,
			device_id                TEXT UNIQUE REFERENCES linked_devices(id)
		);
		CREATE TABLE IF NOT EXISTS device_audit (
			id            TEXT PRIMARY KEY,
			device_id     TEXT REFERENCES linked_devices(id),
			request_id    TEXT REFERENCES device_link_requests(id),
			actor_user_id TEXT REFERENCES auth_users(id),
			action        TEXT NOT NULL,
			detail_json   TEXT,
			created_at    TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS device_request_nonces (
			device_id  TEXT NOT NULL REFERENCES linked_devices(id),
			nonce      TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			PRIMARY KEY (device_id, nonce)
		);
		CREATE INDEX IF NOT EXISTS idx_linked_devices_owner ON linked_devices(owner_user_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_linked_devices_status ON linked_devices(status, last_used_at DESC);
		CREATE INDEX IF NOT EXISTS idx_device_credentials_active ON device_credentials(device_id, revoked_at, expires_at);
		CREATE INDEX IF NOT EXISTS idx_device_link_requests_state_expiry ON device_link_requests(status, expires_at);
		CREATE INDEX IF NOT EXISTS idx_device_audit_device_created ON device_audit(device_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_device_audit_request_created ON device_audit(request_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_device_request_nonces_expiry ON device_request_nonces(expires_at);
		CREATE INDEX IF NOT EXISTS idx_instances_device ON instances(device_id);
		CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id, received_at);
		CREATE INDEX IF NOT EXISTS idx_clients_device ON clients(device_id);
		CREATE INDEX IF NOT EXISTS idx_sync_events_device ON sync_events(device_id, received_at);
	`);
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

// --- Linked device identity (docs/device-linking-v1.md) --------------------

function deviceError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

function normalizeDeviceScopes(scopes) {
	if (!Array.isArray(scopes) || scopes.length === 0) throw deviceError("invalid_device_scopes", "at least one device scope is required");
	const normalized = [...new Set(scopes)].sort();
	if (normalized.some((scope) => !DEVICE_SCOPE_SET.has(scope))) {
		throw deviceError("invalid_device_scopes", "unknown device scope");
	}
	return normalized;
}

function parseDeviceScopes(json) {
	try {
		const scopes = JSON.parse(json);
		return Array.isArray(scopes) ? scopes : [];
	} catch {
		return [];
	}
}

/** A linked identity is not automatically a currently reachable hub. */
export const DEVICE_ONLINE_TTL_MS = Number.parseInt(
	process.env.TARGET_DEVICE_ONLINE_TTL_MS ?? process.env.TARGET_SYNC_CLIENT_ONLINE_TTL_MS ?? "30000",
	10,
);

export function deviceOperationalStatus(row, nowMs = Date.now(), ttlMs = DEVICE_ONLINE_TTL_MS) {
	if (row.status === "revoked") return "revoked";
	const seen = Date.parse(row.last_used_at ?? "");
	return Number.isFinite(seen) && nowMs - seen <= ttlMs ? "online" : "offline";
}

/** Safe public representation: deliberately excludes public-key material and every credential hash. */
function rowToLinkedDevice(row, nowMs = Date.now()) {
	if (!row) return null;
	return {
		id: row.id,
		ownerUserId: row.owner_user_id,
		name: row.name,
		hubVersion: row.hub_version,
		scopes: parseDeviceScopes(row.scopes_json),
		status: row.status,
		operationalStatus: deviceOperationalStatus(row, nowMs),
		credentialVersion: row.credential_version,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at,
		revokedByUserId: row.revoked_by_user_id,
		revocationReason: row.revocation_reason,
	};
}

function rowToLinkRequest(row) {
	if (!row) return null;
	return {
		id: row.id,
		deviceName: row.device_name,
		hubVersion: row.hub_version,
		scopes: parseDeviceScopes(row.scopes_json),
		ownerUserId: row.owner_user_id,
		status: row.status,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		decidedAt: row.decided_at,
		consumedAt: row.consumed_at,
		deviceId: row.device_id,
	};
}

function writeDeviceAudit({ deviceId = null, requestId = null, actorUserId = null, action, detail = null, createdAt = null }) {
	open()
		.prepare(
			`INSERT INTO device_audit
			 (id, device_id, request_id, actor_user_id, action, detail_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			randomUUID(),
			deviceId,
			requestId,
			actorUserId,
			action,
			detail == null ? null : JSON.stringify(detail),
			createdAt ?? new Date().toISOString(),
		);
}

function getLinkedDeviceRow(id) {
	return open().prepare("SELECT * FROM linked_devices WHERE id = ?").get(id);
}

function getLinkRequestRow(id) {
	return open().prepare("SELECT * FROM device_link_requests WHERE id = ?").get(id);
}

/** Create a pending request; callers pass hashes, never raw pairing credentials. */
export function createDeviceLinkRequest({
	id = randomUUID(),
	idempotencyKey = null,
	idempotencyFingerprint = null,
	deviceName,
	hubVersion = null,
	publicKey,
	scopes,
	pollingCredentialHash,
	expiresAt,
	createdAt = null,
}) {
	if (!deviceName?.trim() || !publicKey?.trim() || !pollingCredentialHash?.trim() || !expiresAt) {
		throw deviceError("invalid_link_request", "missing device-link request fields");
	}
	const normalizedScopes = normalizeDeviceScopes(scopes);
	const now = createdAt ?? new Date().toISOString();
	const database = open();
	try {
		database
			.prepare(
				`INSERT INTO device_link_requests
				 (id, idempotency_key, idempotency_fingerprint, device_name, hub_version, public_key, scopes_json,
				  polling_credential_hash, status, created_at, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
			)
			.run(id, idempotencyKey, idempotencyFingerprint, deviceName.trim(), hubVersion, publicKey.trim(), JSON.stringify(normalizedScopes), pollingCredentialHash, now, expiresAt);
		writeDeviceAudit({ requestId: id, action: "link.initiated", detail: { scopes: normalizedScopes }, createdAt: now });
		return rowToLinkRequest(getLinkRequestRow(id));
	} catch (err) {
		if (idempotencyKey && /UNIQUE constraint failed: device_link_requests.idempotency_key/.test(err.message)) {
			const existing = open().prepare("SELECT * FROM device_link_requests WHERE idempotency_key = ?").get(idempotencyKey);
			if (existing?.idempotency_fingerprint === idempotencyFingerprint) {
				return { ...rowToLinkRequest(existing), idempotent: true };
			}
			throw deviceError("idempotency_conflict", "idempotency key belongs to a different request");
		}
		throw err;
	}
}

export function getDeviceLinkRequest(id) {
	return rowToLinkRequest(getLinkRequestRow(id));
}

/** Internal lookup for Target-Link authentication; the hash is never returned. */
export function getDeviceLinkRequestByPollingCredentialHash(pollingCredentialHash) {
	const row = open().prepare("SELECT * FROM device_link_requests WHERE polling_credential_hash = ?").get(pollingCredentialHash);
	return rowToLinkRequest(row);
}

/** Authenticate a pending pairing credential without exposing its stored hash. */
export function authenticateDeviceLinkRequest({ requestId, pollingCredentialHash, now = new Date().toISOString() }) {
	const row = open()
		.prepare("SELECT * FROM device_link_requests WHERE id = ? AND polling_credential_hash = ?")
		.get(requestId, pollingCredentialHash);
	if (!row) return null;
	if ((row.status === "pending" || row.status === "approved") && row.expires_at <= now) {
		open().prepare("UPDATE device_link_requests SET status = 'expired' WHERE id = ? AND status IN ('pending', 'approved')").run(requestId);
		writeDeviceAudit({ requestId, action: "link.expired", createdAt: now });
		return null;
	}
	return rowToLinkRequest(row);
}

/** Approve or deny only a live pending request and only for an existing human owner. */
export function decideDeviceLinkRequest({ requestId, ownerUserId, decision, decidedAt = null }) {
	if (decision !== "approved" && decision !== "denied") throw deviceError("invalid_link_decision", "invalid link decision");
	if (!getAuthUserById(ownerUserId)) throw deviceError("owner_not_found", "link owner does not exist");
	const now = decidedAt ?? new Date().toISOString();
	const database = open();
	database.exec("BEGIN IMMEDIATE");
	try {
		const request = getLinkRequestRow(requestId);
		if (!request) throw deviceError("link_request_not_found", "link request does not exist");
		if (request.status === decision && request.owner_user_id === ownerUserId) {
			database.exec("COMMIT");
			return { ...rowToLinkRequest(request), idempotent: true };
		}
		if (request.status !== "pending" || request.expires_at <= now) {
			if (request.status === "pending" && request.expires_at <= now) {
				database.prepare("UPDATE device_link_requests SET status = 'expired' WHERE id = ? AND status = 'pending'").run(requestId);
			}
			throw deviceError("invalid_link_state", "link request is no longer pending");
		}
		const info = database
			.prepare(
				`UPDATE device_link_requests SET status = ?, owner_user_id = ?, decided_at = ?
				 WHERE id = ? AND status = 'pending'`,
			)
			.run(decision, ownerUserId, now, requestId);
		if (info.changes !== 1) throw deviceError("invalid_link_state", "link request state changed");
		writeDeviceAudit({ requestId, actorUserId: ownerUserId, action: `link.${decision}`, createdAt: now });
		const decided = rowToLinkRequest(getLinkRequestRow(requestId));
		database.exec("COMMIT");
		return decided;
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

/**
 * Atomically materialize an approved request. Both hashes are supplied by the
 * route layer; neither the raw polling credential nor device secret reaches DB.
 */
export function consumeDeviceLinkRequest({
	requestId,
	pollingCredentialHash,
	deviceId = randomUUID(),
	deviceSecretHash,
	consumedAt = null,
	credentialExpiresAt = null,
}) {
	if (!pollingCredentialHash?.trim() || !deviceSecretHash?.trim()) throw deviceError("invalid_link_credential", "credential hash is required");
	const now = consumedAt ?? new Date().toISOString();
	const database = open();
	database.exec("BEGIN IMMEDIATE");
	try {
		const request = getLinkRequestRow(requestId);
		if (!request || request.polling_credential_hash !== pollingCredentialHash) throw deviceError("invalid_link_credential", "invalid link credential");
		if (request.status === "consumed") throw deviceError("already_consumed", "link request was already consumed");
		if (request.status !== "approved" || !request.owner_user_id || request.expires_at <= now) {
			if (request.status === "approved" && request.expires_at <= now) {
				database.prepare("UPDATE device_link_requests SET status = 'expired' WHERE id = ? AND status = 'approved'").run(requestId);
			}
			throw deviceError("invalid_link_state", "link request is not consumable");
		}
		if (!getAuthUserById(request.owner_user_id)) throw deviceError("owner_not_found", "link owner does not exist");
		database
			.prepare(
				`INSERT INTO linked_devices
				 (id, owner_user_id, name, hub_version, public_key, scopes_json, status, credential_version, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
			)
			.run(deviceId, request.owner_user_id, request.device_name, request.hub_version, request.public_key, request.scopes_json, now, now);
		database
			.prepare(
				`INSERT INTO device_credentials (device_id, version, secret_hash, issued_at, expires_at)
				 VALUES (?, 1, ?, ?, ?)`,
			)
			.run(deviceId, deviceSecretHash, now, credentialExpiresAt);
		const consumed = database
			.prepare(
				`UPDATE device_link_requests SET status = 'consumed', consumed_at = ?, device_id = ?
				 WHERE id = ? AND status = 'approved' AND polling_credential_hash = ?`,
			)
			.run(now, deviceId, requestId, pollingCredentialHash);
		if (consumed.changes !== 1) throw deviceError("already_consumed", "link request was already consumed");
		writeDeviceAudit({ deviceId, requestId, actorUserId: request.owner_user_id, action: "link.consumed", createdAt: now });
		const device = rowToLinkedDevice(getLinkedDeviceRow(deviceId));
		database.exec("COMMIT");
		return device;
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

export function expireDeviceLinkRequests(now = new Date().toISOString()) {
	const database = open();
	const rows = database
		.prepare("SELECT id FROM device_link_requests WHERE status IN ('pending', 'approved') AND expires_at <= ?")
		.all(now);
	if (rows.length === 0) return 0;
	database.prepare("UPDATE device_link_requests SET status = 'expired' WHERE status IN ('pending', 'approved') AND expires_at <= ?").run(now);
	for (const row of rows) writeDeviceAudit({ requestId: row.id, action: "link.expired", createdAt: now });
	return rows.length;
}

export function getLinkedDevice(id) {
	return rowToLinkedDevice(getLinkedDeviceRow(id));
}

export function listLinkedDevices({ ownerUserId = null, includeArchived = false, nowMs = Date.now() } = {}) {
	const activeClause = includeArchived ? "" : "status != 'revoked'";
	const rows = ownerUserId
		? open().prepare(`SELECT * FROM linked_devices WHERE owner_user_id = ? ${activeClause ? `AND ${activeClause}` : ""} ORDER BY created_at DESC`).all(ownerUserId)
		: open().prepare(`SELECT * FROM linked_devices ${activeClause ? `WHERE ${activeClause}` : ""} ORDER BY created_at DESC`).all();
	return rows.map((row) => rowToLinkedDevice(row, nowMs));
}

/** Authenticate the active, non-revoked credential and update last-use metadata. */
export function authenticateDevice({ deviceId, secretHash, now = new Date().toISOString() }) {
	const row = open()
		.prepare(
			`SELECT d.* FROM linked_devices d
			 JOIN device_credentials c ON c.device_id = d.id AND c.version = d.credential_version
			 WHERE d.id = ? AND c.secret_hash = ? AND d.status = 'active'
			   AND d.revoked_at IS NULL AND c.revoked_at IS NULL
			   AND (c.expires_at IS NULL OR c.expires_at > ?)`,
		)
		.get(deviceId, secretHash, now);
	if (!row) return null;
	open().prepare("UPDATE linked_devices SET last_used_at = ?, updated_at = ? WHERE id = ?").run(now, now, deviceId);
	return rowToLinkedDevice({ ...row, last_used_at: now, updated_at: now });
}

/** Authentication material is internal-only; public API mappers never expose it. */
export function getDeviceDisconnectAuthentication({ deviceId, secretHash }) {
	return open()
		.prepare(
			`SELECT d.id, d.public_key, d.scopes_json, d.status, d.revoked_at
			 FROM linked_devices d JOIN device_credentials c ON c.device_id = d.id
			 WHERE d.id = ? AND c.secret_hash = ? AND c.version = d.credential_version LIMIT 1`,
		)
		.get(deviceId, secretHash);
}

/** Atomic one-use nonce reservation for signed device requests. */
export function consumeDeviceRequestNonce({ deviceId, nonce, expiresAt }) {
	try {
		open().prepare("DELETE FROM device_request_nonces WHERE expires_at <= ?").run(new Date().toISOString());
		open().prepare("INSERT INTO device_request_nonces (device_id, nonce, expires_at) VALUES (?, ?, ?)").run(deviceId, nonce, expiresAt);
		return true;
	} catch {
		return false;
	}
}

/** Supersede exactly the active credential; the returned object never exposes a hash. */
export function rotateDeviceCredential({ deviceId, currentSecretHash, newSecretHash, expiresAt = null, rotatedAt = null }) {
	if (!currentSecretHash?.trim() || !newSecretHash?.trim()) throw deviceError("invalid_device_credential", "credential hashes are required");
	const now = rotatedAt ?? new Date().toISOString();
	const database = open();
	database.exec("BEGIN IMMEDIATE");
	try {
		const device = getLinkedDeviceRow(deviceId);
		if (!device || device.status !== "active" || device.revoked_at) throw deviceError("device_not_active", "device is not active");
		const credential = database
			.prepare("SELECT * FROM device_credentials WHERE device_id = ? AND version = ? AND revoked_at IS NULL")
			.get(deviceId, device.credential_version);
		if (!credential || credential.secret_hash !== currentSecretHash) throw deviceError("invalid_device_credential", "invalid device credential");
		const nextVersion = device.credential_version + 1;
		database.prepare("UPDATE device_credentials SET revoked_at = ? WHERE device_id = ? AND version = ? AND revoked_at IS NULL").run(now, deviceId, device.credential_version);
		database
			.prepare("INSERT INTO device_credentials (device_id, version, secret_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)")
			.run(deviceId, nextVersion, newSecretHash, now, expiresAt);
		database
			.prepare("UPDATE linked_devices SET credential_version = ?, updated_at = ? WHERE id = ? AND status = 'active'")
			.run(nextVersion, now, deviceId);
		writeDeviceAudit({ deviceId, action: "credential.rotated", createdAt: now });
		const rotated = rowToLinkedDevice(getLinkedDeviceRow(deviceId));
		database.exec("COMMIT");
		return rotated;
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

export function revokeLinkedDevice({ deviceId, actorUserId, reason = null, revokedAt = null }) {
	if (!getAuthUserById(actorUserId)) throw deviceError("owner_not_found", "revocation actor does not exist");
	const now = revokedAt ?? new Date().toISOString();
	const database = open();
	database.exec("BEGIN IMMEDIATE");
	try {
		const device = getLinkedDeviceRow(deviceId);
		if (!device) throw deviceError("device_not_found", "device does not exist");
		if (device.status === "revoked") {
			database.exec("COMMIT");
			return { ...rowToLinkedDevice(device), idempotent: true };
		}
		database
			.prepare(
				`UPDATE linked_devices
				 SET status = 'revoked', revoked_at = ?, revoked_by_user_id = ?, revocation_reason = ?, updated_at = ?
				 WHERE id = ? AND status != 'revoked'`,
			)
			.run(now, actorUserId, reason, now, deviceId);
		database.prepare("UPDATE device_credentials SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(now, deviceId);
		database.prepare("UPDATE clients SET status = 'archived' WHERE device_id = ? AND status != 'archived'").run(deviceId);
		writeDeviceAudit({ deviceId, actorUserId, action: "device.revoked", detail: reason ? { reason } : null, createdAt: now });
		const revoked = rowToLinkedDevice(getLinkedDeviceRow(deviceId));
		database.exec("COMMIT");
		return revoked;
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

/** Device-authenticated remote disconnect. A known revoked credential is safe to replay only here. */
export function disconnectLinkedDevice({ deviceId, secretHash, disconnectedAt = null }) {
	const now = disconnectedAt ?? new Date().toISOString();
	const database = open();
	database.exec("BEGIN IMMEDIATE");
	try {
		const credential = database
			.prepare("SELECT d.* FROM linked_devices d JOIN device_credentials c ON c.device_id = d.id WHERE d.id = ? AND c.secret_hash = ? LIMIT 1")
			.get(deviceId, secretHash);
		if (!credential) throw deviceError("invalid_device_credential", "invalid device credential");
		if (credential.status !== "revoked" && !parseDeviceScopes(credential.scopes_json).includes("sync:write")) {
			throw deviceError("scope_forbidden", "device cannot disconnect remote sync");
		}
		if (credential.status === "revoked") {
			database.exec("COMMIT");
			return { device: rowToLinkedDevice(credential), idempotent: true };
		}
		database.prepare("UPDATE linked_devices SET status = 'revoked', revoked_at = ?, revocation_reason = 'device_disconnected', updated_at = ? WHERE id = ?").run(now, now, deviceId);
		database.prepare("UPDATE device_credentials SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(now, deviceId);
		database.prepare("UPDATE clients SET status = 'archived' WHERE device_id = ? AND status != 'archived'").run(deviceId);
		writeDeviceAudit({ deviceId, action: "device.disconnected", createdAt: now });
		const device = rowToLinkedDevice(getLinkedDeviceRow(deviceId));
		database.exec("COMMIT");
		return { device, idempotent: false };
	} catch (err) {
		database.exec("ROLLBACK");
		throw err;
	}
}

export function listDeviceAudit({ deviceId = null, requestId = null, limit = 100 } = {}) {
	const capped = Math.max(1, Math.min(500, limit));
	const clause = deviceId ? "WHERE device_id = ?" : requestId ? "WHERE request_id = ?" : "";
	const param = deviceId ?? requestId;
	const rows = param
		? open().prepare(`SELECT * FROM device_audit ${clause} ORDER BY created_at DESC LIMIT ?`).all(param, capped)
		: open().prepare("SELECT * FROM device_audit ORDER BY created_at DESC LIMIT ?").all(capped);
	return rows.map((row) => ({
		id: row.id,
		deviceId: row.device_id,
		requestId: row.request_id,
		actorUserId: row.actor_user_id,
		action: row.action,
		detail: row.detail_json ? JSON.parse(row.detail_json) : null,
		createdAt: row.created_at,
	}));
}

export async function adminHasDefaultPassword() {
	const user = getAuthUserByEmail(DEFAULT_ADMIN_EMAIL);
	if (!user?.passwordHash) return false;
	const { verifyPassword } = await import("./auth.mjs");
	return await verifyPassword(DEFAULT_ADMIN_PASSWORD, user.passwordHash);
}

/** Upsert the instance identity carried by a batch envelope. */
export function upsertInstance(batch, nowIso, device = null) {
	open()
		.prepare(
			`INSERT INTO instances (instance_id, display_name, version, first_seen_at, last_seen_at, events_count, device_id, owner_user_id)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?)
			 ON CONFLICT(instance_id) DO UPDATE SET
			   display_name = COALESCE(excluded.display_name, instances.display_name),
			   version      = COALESCE(excluded.version, instances.version),
			   last_seen_at = excluded.last_seen_at,
			   device_id = COALESCE(excluded.device_id, instances.device_id),
			   owner_user_id = COALESCE(excluded.owner_user_id, instances.owner_user_id)`,
		)
		.run(
			batch.instance_id,
			batch.user?.display_name ?? null,
			batch.version ?? null,
			nowIso,
			nowIso,
			device?.id ?? null,
			device?.ownerUserId ?? null,
		);
}

/**
 * Insert one event idempotently. Returns "inserted" | "duplicate" | "rejected".
 * A missing id is the only hard reject (we can't dedupe it); everything else is
 * stored as-is.
 */
export function insertEvent(instanceId, version, event, nowIso, device = null) {
	if (!event || typeof event.id !== "string" || typeof event.kind !== "string") return "rejected";
	const info = open()
		.prepare(
			`INSERT OR IGNORE INTO events (id, instance_id, kind, workflow_id, session_id, version, created_at, received_at, data, device_id, owner_user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			device?.id ?? null,
			device?.ownerUserId ?? null,
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
		deviceId: r.device_id ?? null,
		ownerUserId: r.owner_user_id ?? null,
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
	deviceId = null,
	ownerUserId = null,
}) {
	const now = createdAt ?? new Date().toISOString();
	const capabilitiesJson = capabilities == null ? null : JSON.stringify(capabilities);
	open()
		.prepare(
			`INSERT INTO clients (id, name, token_hash, status, capabilities_json, last_seen_at, created_at, device_id, owner_user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = COALESCE(excluded.name, clients.name),
			   token_hash = COALESCE(excluded.token_hash, clients.token_hash),
			   status = COALESCE(excluded.status, clients.status),
			   capabilities_json = COALESCE(excluded.capabilities_json, clients.capabilities_json),
			   last_seen_at = COALESCE(excluded.last_seen_at, clients.last_seen_at),
			   device_id = COALESCE(excluded.device_id, clients.device_id),
			   owner_user_id = COALESCE(excluded.owner_user_id, clients.owner_user_id)`,
		)
		.run(id, name, tokenHash, status, capabilitiesJson, lastSeenAt ?? now, now, deviceId, ownerUserId);
	return rowToClient(open().prepare("SELECT * FROM clients WHERE id = ?").get(id));
}

/** List registered sync clients, newest first. */
export function listClients() {
	return open()
		.prepare("SELECT * FROM clients ORDER BY created_at DESC")
		.all()
		.map(rowToClient);
}

/** Default 30s (~3× a 10s hub heartbeat); online is TTL-after-last-seen, not an explicit leave. */
export const SYNC_CLIENT_ONLINE_TTL_MS = Number.parseInt(
	process.env.TARGET_SYNC_CLIENT_ONLINE_TTL_MS ?? "30000",
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
	device = null,
}) {
	const now = receivedAt ?? new Date().toISOString();
	const info = open()
		.prepare(
			`INSERT OR IGNORE INTO sync_events (id, client_id, remote_id, type, payload_json, received_at, device_id, owner_user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(id, clientId, remoteId, type, JSON.stringify(payload), now, device?.id ?? null, device?.ownerUserId ?? null);
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

// --- Server catalog (templates, TCP packs, RCI resource sets) ---------
//
// Server-owned library, same public shapes as the hub. Each domain uses one
// table with tags + payload JSON; remote_resources (per-client sync mirrors)
// is a different store and is not touched here.

const CATALOG_RESOURCE_KINDS = Object.freeze(["skill", "agent", "doc"]);
const CATALOG_STEP_NOTE_THEMES = Object.freeze(["warning", "success", "neutral"]);

function parseCatalogJson(raw, fallback) {
	try {
		return JSON.parse(raw ?? "");
	} catch {
		return fallback;
	}
}

function normalizeCatalogTags(tags) {
	if (!Array.isArray(tags)) return [];
	return tags.map((tag) => String(tag).trim()).filter((tag) => tag !== "");
}

function normalizeCatalogName(name) {
	return typeof name === "string" ? name.trim() : "";
}

function catalogIdSet(table) {
	const sql =
		table === "tcps"
			? "SELECT id FROM tcps"
			: table === "resource_sets"
				? "SELECT id FROM resource_sets"
				: null;
	if (!sql) return new Set();
	return new Set(open().prepare(sql).all().map((row) => row.id));
}

function normalizeCatalogTcpIds(tcpIds) {
	if (!Array.isArray(tcpIds)) return [];
	return [...new Set(tcpIds.map((id) => String(id).trim()).filter((id) => id !== ""))];
}

function normalizeCatalogTcpSelections(input) {
	if (!Array.isArray(input)) return [];
	const out = [];
	for (const raw of input) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const tcpId =
			typeof raw.tcpId === "string" ? raw.tcpId.trim() : typeof raw.mtpId === "string" ? raw.mtpId.trim() : "";
		if (tcpId === "") continue;
		let toolNames = null;
		if (raw.toolNames != null) {
			if (!Array.isArray(raw.toolNames)) continue;
			const names = [...new Set(raw.toolNames.map((name) => String(name).trim()).filter((name) => name !== ""))];
			toolNames = names.length === 0 ? null : names;
		}
		out.push({ tcpId, toolNames });
	}
	return out;
}

function normalizeCatalogResourceSelections(input) {
	if (!Array.isArray(input)) return [];
	const out = [];
	for (const raw of input) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const rawId = raw.resourceSetId ?? raw.skillSetId;
		const rawNames = raw.resourceNames ?? raw.skillNames;
		const resourceSetId = typeof rawId === "string" ? rawId.trim() : "";
		if (resourceSetId === "") continue;
		let resourceNames = null;
		if (rawNames != null) {
			if (!Array.isArray(rawNames)) continue;
			const names = [...new Set(rawNames.map((name) => String(name).trim()).filter((name) => name !== ""))];
			resourceNames = names.length === 0 ? null : names;
		}
		out.push({ resourceSetId, resourceNames });
	}
	return out;
}

function filterTcpSelectionsToServer(selections) {
	const known = catalogIdSet("tcps");
	return selections.filter((selection) => known.has(selection.tcpId));
}

function filterResourceSelectionsToServer(selections) {
	const known = catalogIdSet("resource_sets");
	return selections.filter((selection) => known.has(selection.resourceSetId));
}

function normalizeCatalogStepNoteTheme(value) {
	return CATALOG_STEP_NOTE_THEMES.includes(value) ? value : "neutral";
}

function normalizeCatalogTemplateStepNotes(notes) {
	if (!Array.isArray(notes)) return [];
	return notes
		.map((raw) => {
			const obj = raw ?? {};
			const content = typeof obj.content === "string" ? obj.content.trim() : "";
			if (content === "") return null;
			const id = typeof obj.id === "string" && obj.id !== "" ? obj.id : randomUUID();
			return { id, content, theme: normalizeCatalogStepNoteTheme(obj.theme) };
		})
		.filter((note) => note !== null);
}

function normalizeCatalogTemplateSteps(steps) {
	if (!Array.isArray(steps)) return [];
	return steps
		.map((raw) => {
			const obj = raw ?? {};
			const description = typeof obj.description === "string" ? obj.description.trim() : "";
			const acceptanceCriteria =
				typeof obj.acceptanceCriteria === "string" && obj.acceptanceCriteria.trim() !== ""
					? obj.acceptanceCriteria.trim()
					: null;
			const notes = normalizeCatalogTemplateStepNotes(obj.notes);
			return {
				description,
				acceptanceCriteria,
				manualReview: obj.manualReview === true,
				useSubagent: obj.useSubagent !== false,
				maxRetries: Math.max(0, Math.floor(Number(obj.maxRetries ?? 0)) || 0),
				retryIntervalSeconds: Math.max(0, Math.floor(Number(obj.retryIntervalSeconds ?? 0)) || 0),
				...(notes.length > 0 ? { notes } : {}),
			};
		})
		.filter((step) => step.description !== "");
}

function resolveCatalogTemplateSelections(input, existing = null) {
	let tcpSelections = existing?.tcpSelections ?? [];
	if (input.tcpSelections !== undefined) tcpSelections = normalizeCatalogTcpSelections(input.tcpSelections);
	else if (input.tcpIds !== undefined) {
		tcpSelections = normalizeCatalogTcpIds(input.tcpIds).map((tcpId) => ({ tcpId }));
	}
	tcpSelections = filterTcpSelectionsToServer(tcpSelections);
	const tcpIds = tcpSelections.map((selection) => selection.tcpId);
	const resourceSelections =
		input.resourceSelections !== undefined
			? filterResourceSelectionsToServer(normalizeCatalogResourceSelections(input.resourceSelections))
			: (existing?.resourceSelections ?? []);
	return { tcpIds, tcpSelections, resourceSelections };
}

function rowToCatalogTemplate(row) {
	const tags = Array.isArray(parseCatalogJson(row.tags, [])) ? parseCatalogJson(row.tags, []).map((tag) => String(tag)) : [];
	const payload = parseCatalogJson(row.payload, {}) ?? {};
	const steps = normalizeCatalogTemplateSteps(payload.steps);
	const tcpSelections = filterTcpSelectionsToServer(
		normalizeCatalogTcpSelections(payload.tcpSelections).length > 0
			? normalizeCatalogTcpSelections(payload.tcpSelections)
			: normalizeCatalogTcpIds(payload.tcpIds).map((tcpId) => ({ tcpId })),
	);
	const resourceSelections = filterResourceSelectionsToServer(normalizeCatalogResourceSelections(payload.resourceSelections));
	return {
		id: row.id,
		name: row.name,
		tags,
		steps,
		tcpIds: tcpSelections.map((selection) => selection.tcpId),
		tcpSelections,
		resourceSelections,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function writeCatalogTemplatePayload(template) {
	return JSON.stringify({
		steps: template.steps,
		tcpIds: template.tcpIds,
		tcpSelections: template.tcpSelections,
		resourceSelections: template.resourceSelections,
	});
}

export function listTemplates() {
	return open()
		.prepare("SELECT * FROM templates ORDER BY created_at DESC, rowid DESC")
		.all()
		.map(rowToCatalogTemplate);
}

export function getTemplate(id) {
	const row = open().prepare("SELECT * FROM templates WHERE id = ?").get(id);
	return row ? rowToCatalogTemplate(row) : null;
}

export function createTemplate(input = {}) {
	const now = new Date().toISOString();
	const selections = resolveCatalogTemplateSelections(input);
	const template = {
		id: randomUUID(),
		name: normalizeCatalogName(input.name),
		tags: normalizeCatalogTags(input.tags),
		steps: normalizeCatalogTemplateSteps(input.steps),
		...selections,
		createdAt: now,
		updatedAt: now,
	};
	open()
		.prepare("INSERT INTO templates (id, name, tags, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
		.run(template.id, template.name, JSON.stringify(template.tags), writeCatalogTemplatePayload(template), template.createdAt, template.updatedAt);
	return template;
}

export function updateTemplate(id, input = {}) {
	const existing = getTemplate(id);
	if (!existing) return null;
	const selections = resolveCatalogTemplateSelections(input, existing);
	const template = {
		...existing,
		name: input.name !== undefined ? normalizeCatalogName(input.name) : existing.name,
		tags: input.tags !== undefined ? normalizeCatalogTags(input.tags) : existing.tags,
		steps: input.steps !== undefined ? normalizeCatalogTemplateSteps(input.steps) : existing.steps,
		...selections,
		updatedAt: new Date().toISOString(),
	};
	open()
		.prepare("UPDATE templates SET name = ?, tags = ?, payload = ?, updated_at = ? WHERE id = ?")
		.run(template.name, JSON.stringify(template.tags), writeCatalogTemplatePayload(template), template.updatedAt, id);
	return template;
}

export function deleteTemplate(id) {
	return open().prepare("DELETE FROM templates WHERE id = ?").run(id).changes > 0;
}

function normalizeCatalogToolInputs(inputs) {
	if (!Array.isArray(inputs)) return [];
	const out = [];
	for (const raw of inputs) {
		const obj = raw ?? {};
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		const placeholder = typeof obj.placeholder === "string" ? obj.placeholder.trim() : "";
		const description = typeof obj.description === "string" ? obj.description.trim() : "";
		if (name === "" || placeholder === "") continue;
		out.push({
			name,
			placeholder: placeholder.startsWith("$") ? placeholder : `$${placeholder}`,
			description,
			required: obj.required === false ? false : true,
		});
	}
	return out;
}

function normalizeCatalogTokens(tokens) {
	if (tokens == null || typeof tokens !== "object" || Array.isArray(tokens)) return {};
	const out = {};
	for (const [key, value] of Object.entries(tokens)) {
		const name = String(key).trim();
		if (name === "") continue;
		out[name] = typeof value === "string" ? value : String(value ?? "");
	}
	return out;
}

function normalizeCatalogTcpTools(tools) {
	if (!Array.isArray(tools)) return [];
	return tools
		.map((raw) => {
			const obj = raw ?? {};
			const name = typeof obj.name === "string" ? obj.name.trim() : "";
			const description = typeof obj.description === "string" ? obj.description.trim() : "";
			const requestTemplate = typeof obj.requestTemplate === "string" ? obj.requestTemplate.trim() : "";
			if (name === "" || requestTemplate === "") return null;
			return {
				name,
				description,
				requestTemplate,
				inputs: normalizeCatalogToolInputs(obj.inputs),
				tokens: normalizeCatalogTokens(obj.tokens),
			};
		})
		.filter((tool) => tool !== null);
}

function rowToCatalogTcp(row) {
	const tags = Array.isArray(parseCatalogJson(row.tags, [])) ? parseCatalogJson(row.tags, []).map((tag) => String(tag)) : [];
	const payload = parseCatalogJson(row.payload, {}) ?? {};
	return {
		id: row.id,
		name: row.name,
		tags,
		tools: normalizeCatalogTcpTools(payload.tools),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function listTcps() {
	return open()
		.prepare("SELECT * FROM tcps ORDER BY created_at DESC, rowid DESC")
		.all()
		.map(rowToCatalogTcp);
}

export function getTcp(id) {
	const row = open().prepare("SELECT * FROM tcps WHERE id = ?").get(id);
	return row ? rowToCatalogTcp(row) : null;
}

export function createTcp(input = {}) {
	const now = new Date().toISOString();
	const tcp = {
		id: randomUUID(),
		name: normalizeCatalogName(input.name),
		tags: normalizeCatalogTags(input.tags),
		tools: normalizeCatalogTcpTools(input.tools),
		createdAt: now,
		updatedAt: now,
	};
	open()
		.prepare("INSERT INTO tcps (id, name, tags, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
		.run(tcp.id, tcp.name, JSON.stringify(tcp.tags), JSON.stringify({ tools: tcp.tools }), tcp.createdAt, tcp.updatedAt);
	return tcp;
}

export function updateTcp(id, input = {}) {
	const existing = getTcp(id);
	if (!existing) return null;
	const tcp = {
		...existing,
		name: input.name !== undefined ? normalizeCatalogName(input.name) : existing.name,
		tags: input.tags !== undefined ? normalizeCatalogTags(input.tags) : existing.tags,
		tools: input.tools !== undefined ? normalizeCatalogTcpTools(input.tools) : existing.tools,
		updatedAt: new Date().toISOString(),
	};
	open()
		.prepare("UPDATE tcps SET name = ?, tags = ?, payload = ?, updated_at = ? WHERE id = ?")
		.run(tcp.name, JSON.stringify(tcp.tags), JSON.stringify({ tools: tcp.tools }), tcp.updatedAt, id);
	return tcp;
}

export function deleteTcp(id) {
	return open().prepare("DELETE FROM tcps WHERE id = ?").run(id).changes > 0;
}

/** Keeps a bundled file path inside its resource folder; `..` segments empty the path. */
export function normalizeCatalogRelativePath(raw) {
	const cleaned = String(raw).trim().replaceAll("\\", "/").replace(/^\/+/, "");
	if (cleaned === "") return "";
	const parts = [];
	for (const segment of cleaned.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") return "";
		parts.push(segment);
	}
	return parts.join("/");
}

function catalogResourceSlug(name) {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "resource" : slug;
}

function normalizeCatalogResourceKind(raw) {
	const value = String(raw ?? "").trim().toLowerCase();
	return CATALOG_RESOURCE_KINDS.includes(value) ? value : "skill";
}

function normalizeCatalogEntryFile(raw, kind, name) {
	const base = String(raw ?? "")
		.trim()
		.replaceAll("\\", "/")
		.split("/")
		.filter((segment) => segment !== "" && segment !== "." && segment !== "..")
		.pop();
	if (base && /\.(md|markdown|mdx|mdown|mkd)$/i.test(base)) return base;
	return kind === "skill" ? "SKILL.md" : `${catalogResourceSlug(name)}.md`;
}

function normalizeCatalogResourceFiles(files) {
	if (!Array.isArray(files)) return [];
	const seen = new Set();
	const out = [];
	for (const raw of files) {
		const obj = raw ?? {};
		const path = typeof obj.path === "string" ? normalizeCatalogRelativePath(obj.path) : "";
		if (path === "" || seen.has(path)) continue;
		seen.add(path);
		out.push({ path, content: typeof obj.content === "string" ? obj.content : String(obj.content ?? "") });
	}
	return out;
}

function normalizeCatalogResources(resources) {
	if (!Array.isArray(resources)) return [];
	const seen = new Set();
	const out = [];
	for (const raw of resources) {
		const obj = raw ?? {};
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		const content = typeof obj.content === "string" ? obj.content : "";
		if (name === "" || seen.has(name)) continue;
		seen.add(name);
		const kind = normalizeCatalogResourceKind(obj.kind);
		out.push({
			name,
			description: typeof obj.description === "string" ? obj.description.trim() : "",
			kind,
			entryFile: normalizeCatalogEntryFile(obj.entryFile, kind, name),
			content,
			files: normalizeCatalogResourceFiles(obj.files),
		});
	}
	return out;
}

function rowToCatalogResourceSet(row) {
	const tags = Array.isArray(parseCatalogJson(row.tags, [])) ? parseCatalogJson(row.tags, []).map((tag) => String(tag)) : [];
	const payload = parseCatalogJson(row.payload, {}) ?? {};
	return {
		id: row.id,
		name: row.name,
		tags,
		resources: normalizeCatalogResources(payload.resources),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function listResourceSets() {
	return open()
		.prepare("SELECT * FROM resource_sets ORDER BY created_at DESC, rowid DESC")
		.all()
		.map(rowToCatalogResourceSet);
}

export function getResourceSet(id) {
	const row = open().prepare("SELECT * FROM resource_sets WHERE id = ?").get(id);
	return row ? rowToCatalogResourceSet(row) : null;
}

export function createResourceSet(input = {}) {
	const now = new Date().toISOString();
	const set = {
		id: randomUUID(),
		name: normalizeCatalogName(input.name),
		tags: normalizeCatalogTags(input.tags),
		resources: normalizeCatalogResources(input.resources),
		createdAt: now,
		updatedAt: now,
	};
	open()
		.prepare("INSERT INTO resource_sets (id, name, tags, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
		.run(set.id, set.name, JSON.stringify(set.tags), JSON.stringify({ resources: set.resources }), set.createdAt, set.updatedAt);
	return set;
}

export function updateResourceSet(id, input = {}) {
	const existing = getResourceSet(id);
	if (!existing) return null;
	const set = {
		...existing,
		name: input.name !== undefined ? normalizeCatalogName(input.name) : existing.name,
		tags: input.tags !== undefined ? normalizeCatalogTags(input.tags) : existing.tags,
		resources: input.resources !== undefined ? normalizeCatalogResources(input.resources) : existing.resources,
		updatedAt: new Date().toISOString(),
	};
	open()
		.prepare("UPDATE resource_sets SET name = ?, tags = ?, payload = ?, updated_at = ? WHERE id = ?")
		.run(set.name, JSON.stringify(set.tags), JSON.stringify({ resources: set.resources }), set.updatedAt, id);
	return set;
}

export function deleteResourceSet(id) {
	return open().prepare("DELETE FROM resource_sets WHERE id = ?").run(id).changes > 0;
}

export const TEMPLATE_BUNDLE_KIND = "target.templates";
export const TCP_BUNDLE_KIND = "target.tcps";
export const RESOURCE_SET_BUNDLE_KIND = "target-server.resource-sets";
export const CATALOG_BUNDLE_SCHEMA_VERSION = 1;

export function catalogTemplateBundle(templates) {
	return {
		kind: TEMPLATE_BUNDLE_KIND,
		schemaVersion: CATALOG_BUNDLE_SCHEMA_VERSION,
		exportedAt: new Date().toISOString(),
		templates: templates.map((template) => ({
			name: template.name,
			tags: template.tags,
			steps: template.steps,
			tcpIds: template.tcpIds,
			tcpSelections: template.tcpSelections,
			resourceSelections: template.resourceSelections,
		})),
	};
}

export function catalogTcpBundle(tcps) {
	return {
		kind: TCP_BUNDLE_KIND,
		schemaVersion: CATALOG_BUNDLE_SCHEMA_VERSION,
		exportedAt: new Date().toISOString(),
		tcps: tcps.map((tcp) => ({
			name: tcp.name,
			tags: tcp.tags,
			tools: tcp.tools.map((tool) => ({
				...tool,
				tokens: Object.fromEntries(Object.keys(tool.tokens ?? {}).map((key) => [key, ""])),
			})),
		})),
	};
}

export function catalogResourceSetBundle(resourceSets) {
	return {
		kind: RESOURCE_SET_BUNDLE_KIND,
		resourceSets: resourceSets.map((set) => ({
			name: set.name,
			tags: set.tags,
			resources: set.resources,
		})),
	};
}
